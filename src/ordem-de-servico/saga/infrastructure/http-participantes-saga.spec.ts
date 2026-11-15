import { Logger } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { ClienteHttpInterno } from '@guilhermeqmaia/oficina-kit/http';
import { HttpParticipantesSaga, rotaDoComando } from './http-participantes-saga';
import { getCorrelationContext, registrarTracer, resetTracerBridge, runWithCorrelation } from '@guilhermeqmaia/oficina-kit/logging';
import { ComandoSaga, TipoComando } from '../domain/saga-os.entity';
import { ROTAS_HTTP_INTERNO, httpInternoDuracao, httpInternoTotal, integracaoResultados } from '../../../observabilidade/metrics.registry';

const URLS = { execucao: 'http://execucao-service:3002', billing: 'http://billing-service:3001' };
const SECRET = 'segredo-os-service';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const contador = async (integracao: string, resultado: string) =>
  (await integracaoResultados.get()).values.find((v) => v.labels.integracao === integracao && v.labels.resultado === resultado)?.value ?? 0;
const interno = async (destino: string, rota: string, resultado: string) =>
  (await httpInternoTotal.get()).values.find((v) => v.labels.origem === 'os-service' && v.labels.destino === destino && v.labels.rota === rota && v.labels.resultado === resultado)?.value ?? 0;
const duracoes = async (destino: string, rota: string, status: string) =>
  (await httpInternoDuracao.get()).values.find((v) => v.metricName === 'oficina_http_interno_duracao_seconds_count' && v.labels.destino === destino && v.labels.rota === rota && v.labels.status === status)?.value ?? 0;

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

  describe('observabilidade (US-F4-16)', () => {
    const COBRAR = 'POST /orcamentos/{numero}/cobrar';
    const INICIAR = 'POST /execucao/ordens/{numero}/iniciar';

    it('rotaDoComando usa so as rotas-template de ROTAS_HTTP_INTERNO (label sem o numero da OS)', () => {
      const tipos: TipoComando[] = ['execucao.enfileirar', 'execucao.iniciar', 'execucao.liberar-reservas', 'billing.gerar-orcamento', 'billing.cobrar', 'billing.cancelar-orcamento'];
      const usadas = tipos.map((type) => {
        const r = rotaDoComando({ type, data: { numeroOS: 'OS-2026-0042' } } as ComandoSaga, URLS);
        expect(r.rota).not.toContain('OS-2026-0042');
        return { destino: r.participante, rota: r.rota };
      });
      expect(usadas).toEqual(ROTAS_HTTP_INTERNO);
    });

    it('sucesso: oficina_http_interno_total{resultado=sucesso} e duracao com o status HTTP', async () => {
      const [t, d] = [await interno('billing-service', COBRAR, 'sucesso'), await duracoes('billing-service', COBRAR, '201')];
      fetchMock.mockResolvedValueOnce(json(201, { orderId: 'mp-1' }));
      await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } });
      expect(await interno('billing-service', COBRAR, 'sucesso')).toBe(t + 1);
      expect(await duracoes('billing-service', COBRAR, '201')).toBe(d + 1);
    });

    it('409 com evento de recusa -> recusa; 409 "ja existe" -> sucesso; 409 sem evento -> recusa', async () => {
      const antes = await interno('execucao-service', INICIAR, 'recusa');
      fetchMock.mockResolvedValueOnce(json(409, { motivo: 'estoque' }));
      await gateway.executar({ type: 'execucao.iniciar', data: { numeroOS: 'OS-1' } });
      expect(await interno('execucao-service', INICIAR, 'recusa')).toBe(antes + 1);

      const orc = await interno('billing-service', 'POST /orcamentos', 'sucesso');
      fetchMock.mockResolvedValueOnce(json(409, { orcamentoId: 'o' }));
      await gateway.executar({ type: 'billing.gerar-orcamento', data: { numeroOS: 'OS-1', itens: [] } });
      expect(await interno('billing-service', 'POST /orcamentos', 'sucesso')).toBe(orc + 1);

      const cob = await interno('billing-service', COBRAR, 'recusa');
      fetchMock.mockResolvedValueOnce(json(409, { motivo: 'orcamento nao aprovado' }));
      expect(await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } })).toMatchObject({ entregue: false, resultado: 'recusa', tentativas: 1 });
      expect(await interno('billing-service', COBRAR, 'recusa')).toBe(cob + 1);
    });

    it('5xx esgotado -> esgotado (tentativas=3); erro de rede -> esgotado com status sem_resposta; 404 -> erro', async () => {
      const esg = await interno('billing-service', COBRAR, 'esgotado');
      const semResp = await duracoes('billing-service', COBRAR, 'sem_resposta');
      fetchMock.mockImplementation(async () => json(503, {}));
      expect(await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } })).toMatchObject({ entregue: false, resultado: 'esgotado', tentativas: 3, status: 503 });
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      expect(await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } })).toMatchObject({ entregue: false, resultado: 'esgotado', tentativas: 3 });
      expect(await interno('billing-service', COBRAR, 'esgotado')).toBe(esg + 2);
      expect(await duracoes('billing-service', COBRAR, 'sem_resposta')).toBe(semResp + 1);

      fetchMock.mockReset();
      const erro = await interno('execucao-service', INICIAR, 'erro');
      fetchMock.mockResolvedValueOnce(json(404, {}));
      expect(await gateway.executar({ type: 'execucao.iniciar', data: { numeroOS: 'OS-1' } })).toMatchObject({ entregue: false, resultado: 'erro', tentativas: 1 });
      expect(await interno('execucao-service', INICIAR, 'erro')).toBe(erro + 1);
    });

    it('logs levam trace_id, correlation_id (numero da OS), servico, destino, rota e tentativa', async () => {
      fetchMock.mockImplementation(async () => json(503, {}));
      await gateway.executar({ type: 'billing.cobrar', data: { numeroOS: 'OS-7' } });
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'comando nao entregue — tentativas esgotadas', trace_id: 'OS-7', correlation_id: 'OS-7', servico: 'os-service', destino: 'billing-service', rota: COBRAR, tentativa: 3 }),
      );
    });

    it('durante a chamada o contexto do kit tem o numero da OS como correlationId (linhas de retentativa do kit saem com ele) e mantem o trace', async () => {
      const vistos: Array<ReturnType<typeof getCorrelationContext>> = [];
      fetchMock.mockImplementation(async () => { vistos.push(getCorrelationContext()); return json(201, {}); });
      await runWithCorrelation({ correlationId: 'req-abc', traceId: 'trace-da-requisicao' }, () =>
        gateway.executar({ type: 'execucao.iniciar', data: { numeroOS: 'OS-8' } }),
      );
      expect(vistos[0]).toEqual({ correlationId: 'OS-8', traceId: 'trace-da-requisicao' });
    });

    describe('continuidade do trace (APM ativo)', () => {
      // Simula o dd-trace: o span ativo e o que o tracer criou ao continuar o `traceparent` recebido.
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const spanId = '00f067aa0ba902b7';
      beforeEach(() =>
        registrarTracer({ scope: () => ({ active: () => ({ context: () => ({ toTraceId: () => traceId, toSpanId: () => spanId }), setTag: () => undefined }) }) } as never),
      );
      afterEach(() => resetTracerBridge());

      it('a chamada ao participante leva traceparent com o MESMO trace id do span ativo e o log usa esse trace_id', async () => {
        fetchMock.mockResolvedValueOnce(json(201, {}));
        await gateway.executar({ type: 'execucao.enfileirar', data: { numeroOS: 'OS-9', veiculoId: 'v', descricaoProblema: 'd' } });
        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
        expect(headers.traceparent.split('-')[1]).toBe(traceId);
        expect(Logger.prototype.log).toHaveBeenCalledWith(expect.objectContaining({ msg: 'comando executado', trace_id: traceId, correlation_id: 'OS-9' }));
      });
    });
  });
});
