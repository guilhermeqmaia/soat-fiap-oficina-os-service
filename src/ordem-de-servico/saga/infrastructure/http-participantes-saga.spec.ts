import { Logger } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { ClienteHttpInterno } from '@guilhermeqmaia/oficina-kit/http';
import { HttpParticipantesSaga, rotaDoComando } from './http-participantes-saga';
import { integracaoResultados } from '../../../observabilidade/metrics.registry';

const URLS = { execucao: 'http://execucao-service:3002', billing: 'http://billing-service:3001' };
const SECRET = 'segredo-os-service';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const contador = async (integracao: string, resultado: string) =>
  (await integracaoResultados.get()).values.find((v) => v.labels.integracao === integracao && v.labels.resultado === resultado)?.value ?? 0;

describe('HttpParticipantesSaga (fetch mockado)', () => {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
  const originalFetch = global.fetch;
  let gateway: HttpParticipantesSaga;

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });
  beforeEach(() => {
    fetchMock.mockReset();
    // backoff de 1 ms para o retry real do kit nao atrasar o teste
    gateway = new HttpParticipantesSaga(new ClienteHttpInterno({ servico: 'os-service', jwtSecret: SECRET, backoffMs: [1, 1] }), URLS);
  });

  it('rotaDoComando mapeia cada comando para o endpoint/corpo/evento da spec', () => {
    expect(rotaDoComando({ type: 'execucao.enfileirar', data: { numeroOS: 'OS-1', veiculoId: 'v', descricaoProblema: 'd' } }, URLS)).toMatchObject({
      metodo: 'POST', url: 'http://execucao-service:3002/execucao/ordens', body: { numeroOS: 'OS-1', veiculoId: 'v', descricaoProblema: 'd' }, sucesso: 'execucao.enfileirada', recusa: 'execucao.recusada',
    });
    expect(rotaDoComando({ type: 'execucao.iniciar', data: { numeroOS: 'OS 1' } }, URLS)).toMatchObject({ metodo: 'POST', url: 'http://execucao-service:3002/execucao/ordens/OS%201/iniciar', sucesso: 'execucao.iniciada', recusa: 'execucao.recusada' });
    expect(rotaDoComando({ type: 'execucao.liberar-reservas', data: { numeroOS: 'OS-1' } }, URLS)).toMatchObject({ metodo: 'DELETE', url: 'http://execucao-service:3002/execucao/ordens/OS-1', body: { motivo: expect.any(String) }, sucesso: 'execucao.reservas-liberadas' });
    expect(rotaDoComando({ type: 'billing.gerar-orcamento', data: { numeroOS: 'OS-1', clienteId: 'c', itens: [] } }, URLS)).toMatchObject({ metodo: 'POST', url: 'http://billing-service:3001/orcamentos', body: { numeroOS: 'OS-1', clienteId: 'c', itens: [] }, sucesso: 'billing.orcamento-gerado', conflitoEhSucesso: true });
    expect(rotaDoComando({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } }, URLS)).toMatchObject({ metodo: 'POST', url: 'http://billing-service:3001/orcamentos/OS-1/cobrar', sucesso: 'billing.cobranca-criada' });
    expect(rotaDoComando({ type: 'billing.cancelar-orcamento', data: { numeroOS: 'OS-1', motivo: 'OPERADOR' } }, URLS)).toMatchObject({ metodo: 'DELETE', url: 'http://billing-service:3001/orcamentos/OS-1', body: { motivo: 'OPERADOR' }, sucesso: 'billing.orcamento-cancelado' });
  });

  it('201 de POST /execucao/ordens vira execucao.enfileirada com o corpo como data (+numeroOS), JWT de servico e correlacao', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { numeroOS: 'OS-1', posicaoFila: 3 }));
    const r = await gateway.executar({ type: 'execucao.enfileirar', data: { numeroOS: 'OS-1', veiculoId: 'v', descricaoProblema: 'd' } });
    expect(r).toEqual({ entregue: true, evento: { type: 'execucao.enfileirada', data: { numeroOS: 'OS-1', posicaoFila: 3 } } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://execucao-service:3002/execucao/ordens');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ numeroOS: 'OS-1', veiculoId: 'v', descricaoProblema: 'd' });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-correlation-id']).toBe('OS-1');
    expect(jwt.verify(headers.authorization.replace('Bearer ', ''), SECRET)).toMatchObject({ sub: 'os-service', role: 'SERVICO' });
  });

  it('200 de DELETE vira o evento de confirmacao; corpo vazio/nao-objeto ainda gera data com numeroOS', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const r = await gateway.executar({ type: 'execucao.liberar-reservas', data: { numeroOS: 'OS-1' } });
    expect(r).toEqual({ entregue: true, evento: { type: 'execucao.reservas-liberadas', data: { numeroOS: 'OS-1' } } });
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).motivo).toBeDefined();
  });

  it('409 { motivo } em enfileirar/iniciar vira execucao.recusada (sem retry) e conta como recusado', async () => {
    const antes = await contador('execucao-service', 'recusado');
    fetchMock.mockResolvedValueOnce(json(409, { motivo: 'estoque insuficiente' }));
    const r = await gateway.executar({ type: 'execucao.iniciar', data: { numeroOS: 'OS-1' } });
    expect(r).toEqual({ entregue: true, evento: { type: 'execucao.recusada', data: { numeroOS: 'OS-1', motivo: 'estoque insuficiente' } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await contador('execucao-service', 'recusado')).toBe(antes + 1);
    fetchMock.mockResolvedValueOnce(json(409, {}));
    const semMotivo = await gateway.executar({ type: 'execucao.enfileirar', data: { numeroOS: 'OS-1' } });
    expect(semMotivo).toMatchObject({ entregue: true, evento: { type: 'execucao.recusada', data: { motivo: expect.any(String) } } });
  });

  it('409 em POST /orcamentos (orcamento ja existe) e tratado como billing.orcamento-gerado com o corpo devolvido', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { numeroOS: 'OS-1', orcamentoId: 'orc-1', total: '300.00', validoAte: 'x' }));
    const r = await gateway.executar({ type: 'billing.gerar-orcamento', data: { numeroOS: 'OS-1', clienteId: 'c', itens: [] } });
    expect(r).toEqual({ entregue: true, evento: { type: 'billing.orcamento-gerado', data: { numeroOS: 'OS-1', orcamentoId: 'orc-1', total: '300.00', validoAte: 'x' } } });
  });

  it('409 em cobrar (orcamento nao aprovado) nao tem evento: nao entregue, status 409', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { motivo: 'orcamento nao aprovado' }));
    const r = await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } });
    expect(r).toMatchObject({ entregue: false, status: 409 });
  });

  it('404 (OS desconhecida no destino) nao repete e nao entrega', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { message: 'nao encontrada' }));
    const r = await gateway.executar({ type: 'execucao.iniciar', data: { numeroOS: 'OS-1' } });
    expect(r).toMatchObject({ entregue: false, status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx repete 3 vezes e, esgotado, nao entrega (sem evento) e conta como falha', async () => {
    const antes = await contador('billing-service', 'falha');
    fetchMock.mockImplementation(async () => json(503, { erro: 'indisponivel' }));
    const r = await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } });
    expect(r).toMatchObject({ entregue: false, status: 503 });
    expect((r as { erro: string }).erro).toContain('tentativa 3/3');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await contador('billing-service', 'falha')).toBe(antes + 1);
  });

  it('erro de rede esgotado: nao entregue sem status; 5xx seguido de 201 entrega normalmente', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } })).toMatchObject({ entregue: false, status: undefined });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(502, {})).mockResolvedValueOnce(json(201, { numeroOS: 'OS-1', orderId: 'mp-1', linkPagamento: 'https://mp', valor: '300.00' }));
    const r = await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } });
    expect(r).toEqual({ entregue: true, evento: { type: 'billing.cobranca-criada', data: { numeroOS: 'OS-1', orderId: 'mp-1', linkPagamento: 'https://mp', valor: '300.00' } } });
  });
});
