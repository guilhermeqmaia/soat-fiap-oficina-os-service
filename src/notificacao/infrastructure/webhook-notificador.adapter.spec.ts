import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { CanalNotificacao } from '../domain/value-objects/canal-notificacao.vo';
import { WebhookNotificador } from './webhook-notificador.adapter';
import { runWithCorrelation } from '@guilhermeqmaia/oficina-kit/logging';

describe('WebhookNotificador', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const mensagem = {
    destinatario: 'cliente@email.com',
    assunto: 'Status alterado',
    corpo: 'Sua OS mudou de status',
    contexto: {
      ordemId: 'os-1',
      clienteId: 'cliente-1',
      statusAnterior: 'EM_EXECUCAO',
      statusAtual: 'FINALIZADA',
      timestamp: '2026-06-25T10:00:00.000Z',
      tipoNotificacao: 'STATUS_OS_ALTERADO',
    },
  };

  function makeAdapter(timeoutMs = '5000'): WebhookNotificador {
    const config = {
      get: jest.fn((key: string, defaultValue?: string) => {
        const values: Record<string, string> = {
          NOTIFICATION_WEBHOOK_URL: 'https://webhook.site/test-token',
          NOTIFICATION_WEBHOOK_SECRET: 'super-secret',
          NOTIFICATION_WEBHOOK_TIMEOUT_MS: timeoutMs,
        };
        return values[key] ?? defaultValue;
      }),
    } as unknown as ConfigService;

    return new WebhookNotificador(config);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('envia POST com body esperado e assinatura HMAC', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 });
    const adapter = makeAdapter();

    await adapter.enviar(mensagem);

    expect(adapter.canal).toBe(CanalNotificacao.WEBHOOK);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const body = init.body as string;
    const signature = createHmac('sha256', 'super-secret')
      .update(body)
      .digest('hex');

    expect(url).toBe('https://webhook.site/test-token');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Signature': `sha256=${signature}`,
    });
    expect(JSON.parse(body)).toEqual({
      numeroOS: null,
      tipo: 'STATUS_OS_ALTERADO',
      mensagem: 'Sua OS mudou de status',
      ordemId: 'os-1',
      clienteId: 'cliente-1',
      statusAnterior: 'EM_EXECUCAO',
      statusAtual: 'FINALIZADA',
      timestamp: '2026-06-25T10:00:00.000Z',
      tipoNotificacao: 'STATUS_OS_ALTERADO',
    });
  });

  it('US-F4-12: payload { numeroOS, tipo, mensagem, linkPagamento } assinado com HMAC', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const adapter = makeAdapter();

    await adapter.enviar({
      destinatario: 'cliente@email.com',
      assunto: 'OS OS-2026-000001 concluida - pague para retirar o veiculo',
      corpo: 'Pague em https://mp.test/pay/mp-1',
      contexto: {
        ordemId: 'os-1',
        clienteId: 'cliente-1',
        numeroOS: 'OS-2026-000001',
        linkPagamento: 'https://mp.test/pay/mp-1',
        tipoNotificacao: 'PAGAMENTO_PENDENTE',
      },
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = init.body as string;
    expect(init.headers['X-Signature']).toBe(
      `sha256=${createHmac('sha256', 'super-secret').update(body).digest('hex')}`,
    );
    expect(JSON.parse(body)).toMatchObject({
      numeroOS: 'OS-2026-000001',
      tipo: 'PAGAMENTO_PENDENTE',
      mensagem: 'Pague em https://mp.test/pay/mp-1',
      linkPagamento: 'https://mp.test/pay/mp-1',
    });
  });

  it('sem link de pagamento, o campo linkPagamento fica fora do payload', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await makeAdapter().enviar(mensagem);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('linkPagamento');
  });

  it('aplica timeout e tenta uma vez adicional', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const adapter = makeAdapter('1');

    await expect(adapter.enviar(mensagem)).rejects.toThrow(
      'Timeout ao publicar webhook apos 1ms',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('trata status 5xx como falha e tenta uma vez adicional', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const adapter = makeAdapter();

    await expect(adapter.enviar(mensagem)).rejects.toThrow(
      'Webhook retornou status 500',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propaga o correlationId da requisicao no header X-Correlation-Id', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 });
    const adapter = makeAdapter();

    await runWithCorrelation({ correlationId: 'cid-outbound', traceId: 'cid-outbound' }, () =>
      adapter.enviar(mensagem),
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({ 'X-Correlation-Id': 'cid-outbound' });
  });
});
