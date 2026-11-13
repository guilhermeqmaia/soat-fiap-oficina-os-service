import { Logger } from '@nestjs/common';
import { ClienteHttpInterno, HttpInternoError, OpcoesChamadaInterna } from '@guilhermeqmaia/oficina-kit/http';
import { ComandoSaga, EventoSaga, SagaOS, StatusSaga, TipoComando } from '../../src/ordem-de-servico/saga/domain/saga-os.entity';
import { HttpParticipantesSaga, UrlsParticipantes } from '../../src/ordem-de-servico/saga/infrastructure/http-participantes-saga';
import { EndpointParticipante, NUMERO_OS, endpointsParticipantes, fixtureDeCallback, fixtureDeParticipante, valida } from './support/contratos';

/**
 * US-F4-15 — lado CONSUMIDOR: as requisicoes que o OS Service envia ao Billing e
 * a Execucao (HttpParticipantesSaga) e as respostas que ele espera deles batem
 * com http-interno.md (docs/contratos/schemas/endpoints-participantes.json).
 *
 * Os comandos nao sao montados a mao: a SagaOS real percorre o fluxo (caminho
 * feliz e compensacao) e cada comando que ela decide passa pelo
 * HttpParticipantesSaga real, com um ClienteHttpInterno que grava a chamada e
 * responde com a fixture do participante.
 */
const URLS: UrlsParticipantes = { execucao: 'http://execucao-service:3002', billing: 'http://billing-service:3001' };
const BASE: Record<string, string> = { 'execucao-service': URLS.execucao, 'billing-service': URLS.billing };
const CONTRATO = endpointsParticipantes();
const COMANDOS: TipoComando[] = [
  'execucao.enfileirar',
  'execucao.iniciar',
  'execucao.liberar-reservas',
  'billing.gerar-orcamento',
  'billing.cobrar',
  'billing.cancelar-orcamento',
];

interface Chamada {
  comando: TipoComando;
  metodo: 'POST' | 'DELETE';
  url: string;
  body: unknown;
  opcoes?: OpcoesChamadaInterna;
  status: number;
  resposta: unknown;
}

/** Identifica o comando pela rota do contrato (metodo + path com {numeroOS}). */
function comandoDaRota(metodo: string, url: string): TipoComando {
  for (const [comando, ep] of Object.entries(CONTRATO)) {
    const esperado = BASE[ep.participante] + ep.path.replace('{numeroOS}', encodeURIComponent(NUMERO_OS));
    if (ep.metodo === metodo && esperado === url) return comando as TipoComando;
  }
  throw new Error(`requisicao fora do contrato: ${metodo} ${url}`);
}

/** ClienteHttpInterno falso: grava e responde com a fixture (status escolhido por comando). */
class ParticipantesGravados {
  readonly chamadas: Chamada[] = [];
  private readonly statusPorComando = new Map<TipoComando, { status: number; corpo?: unknown }>();

  /** Responde `comando` com `status` (corpo = fixture desse status, ou `corpo`). */
  responderCom(comando: TipoComando, status: number, corpo?: unknown): void {
    this.statusPorComando.set(comando, { status, corpo });
  }

  post = (url: string, body?: unknown, opcoes?: OpcoesChamadaInterna) => this.chamar('POST', url, body, opcoes);
  delete = (url: string, body?: unknown, opcoes?: OpcoesChamadaInterna) => this.chamar('DELETE', url, body, opcoes);

  private async chamar(metodo: 'POST' | 'DELETE', url: string, body: unknown, opcoes?: OpcoesChamadaInterna) {
    const comando = comandoDaRota(metodo, url);
    const { respostas } = fixtureDeParticipante(comando);
    const escolhido = this.statusPorComando.get(comando);
    const status = escolhido?.status ?? Number(Object.keys(respostas).find((s) => s.startsWith('2')));
    const resposta = structuredClone(escolhido?.corpo ?? respostas[String(status)]);
    if (resposta === undefined) throw new Error(`fixture de ${comando} sem resposta ${status}`);
    this.chamadas.push({ comando, metodo, url, body, opcoes, status, resposta });
    if (status >= 400) throw new HttpInternoError(`HTTP ${status}`, metodo, url, status, resposta, 1);
    return { status, body: resposta, headers: new Headers() };
  }
}

function novoCenario() {
  const http = new ParticipantesGravados();
  const participantes = new HttpParticipantesSaga(http as unknown as ClienteHttpInterno, URLS);
  const saga = SagaOS.iniciar({ numero: NUMERO_OS, clienteId: 'cli-0001', veiculoId: 'vei-0001', descricaoProblema: 'Barulho ao frear' });
  const eventos: EventoSaga[] = [];

  /** Como o OrquestradorSagaService: executa os comandos pendentes e reinjeta as respostas. */
  async function drenar(): Promise<void> {
    let comandos: ComandoSaga[];
    while ((comandos = saga.consumirComandos()).length) {
      for (const comando of comandos) {
        const r = await participantes.executar(comando);
        if (!r.entregue) continue;
        eventos.push(r.evento);
        saga.aplicar(r.evento);
      }
    }
  }
  async function callback(type: string): Promise<void> {
    const { id, data } = fixtureDeCallback(type);
    saga.aplicar({ type, id, data });
    await drenar();
  }
  return { http, participantes, saga, eventos, drenar, callback };
}

/** Cada chamada gravada confere com a linha do contrato do seu comando. */
function conferirChamada(c: Chamada, ep: EndpointParticipante, eventoGerado?: EventoSaga): void {
  expect(c.metodo).toBe(ep.metodo);
  expect(c.opcoes?.correlationId).toBe(NUMERO_OS); // x-correlation-id = numero da OS
  if (ep.corpo === null) expect(c.body).toBeUndefined();
  else expect(valida(ep.corpo, c.body)).toBe('');

  const resposta = ep.respostas[String(c.status)];
  expect(resposta).toBeDefined();
  expect(valida(resposta.schema, c.resposta)).toBe('');
  if (resposta.evento && eventoGerado) {
    expect(eventoGerado.type).toBe(resposta.evento);
    // o data que a saga recebe e o corpo da resposta (+ numeroOS)
    if (resposta.schema.startsWith('eventos')) expect(valida(resposta.schema, eventoGerado.data)).toBe('');
  }
}

describe('Contrato do consumidor (OS Service -> Execucao/Billing)', () => {
  beforeAll(() => Logger.overrideLogger(false)); // os 409/recusas logam erro de proposito
  it('a tabela do contrato cobre exatamente os comandos da saga', () => {
    expect(Object.keys(CONTRATO).sort()).toEqual([...COMANDOS].sort());
  });

  it.each(COMANDOS)('fixtures de resposta de %s validam contra o contrato', (comando) => {
    const { respostas } = fixtureDeParticipante(comando);
    for (const [status, corpo] of Object.entries(respostas)) {
      const declarada = CONTRATO[comando].respostas[status];
      expect({ status, declarada: !!declarada }).toEqual({ status, declarada: true });
      expect(valida(declarada.schema, corpo)).toBe('');
    }
  });

  it('DELETE /orcamentos/{n} antes de o orcamento existir: 200 com orcamentoId null e valido', () => {
    expect(valida('eventos.schema.json#/$defs/BillingOrcamentoCancelado', { numeroOS: NUMERO_OS, orcamentoId: null, estornado: false })).toBe('');
  });

  it('caminho feliz: enfileirar -> gerar-orcamento -> iniciar -> cobrar (201 com linkPagamento)', async () => {
    const { http, saga, eventos, drenar, callback } = novoCenario();
    await drenar();
    await callback('execucao.diagnostico-concluido');
    await callback('billing.orcamento-aprovado');
    await callback('execucao.finalizada');
    await callback('billing.pagamento-aprovado');

    expect(http.chamadas.map((c) => c.comando)).toEqual(['execucao.enfileirar', 'billing.gerar-orcamento', 'execucao.iniciar', 'billing.cobrar']);
    http.chamadas.forEach((c, i) => conferirChamada(c, CONTRATO[c.comando], eventos[i]));

    const cobranca = eventos.find((e) => e.type === 'billing.cobranca-criada')!;
    expect(cobranca.data.linkPagamento).toMatch(/^https:\/\//);
    expect(saga.status).toBe(StatusSaga.CONCLUIDA);
  });

  it('itens do diagnostico seguem sem alteracao para POST /orcamentos', async () => {
    const { http, drenar, callback } = novoCenario();
    await drenar();
    await callback('execucao.diagnostico-concluido');
    const gerar = http.chamadas.find((c) => c.comando === 'billing.gerar-orcamento')!;
    expect((gerar.body as { itens: unknown }).itens).toEqual(fixtureDeCallback('execucao.diagnostico-concluido').data.itens);
    expect(gerar.body).toMatchObject({ numeroOS: NUMERO_OS, clienteId: 'cli-0001' });
  });

  it('compensacao (estoque insuficiente ao iniciar): DELETE /orcamentos/{n} e DELETE /execucao/ordens/{n} com { motivo }', async () => {
    const { http, saga, eventos, drenar, callback } = novoCenario();
    http.responderCom('execucao.iniciar', 409);
    await drenar();
    await callback('execucao.diagnostico-concluido');
    await callback('billing.orcamento-aprovado');

    const compensacoes = http.chamadas.filter((c) => c.metodo === 'DELETE');
    expect(compensacoes.map((c) => c.comando).sort()).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
    http.chamadas.forEach((c, i) => conferirChamada(c, CONTRATO[c.comando], eventos[i]));
    expect(saga.status).toBe(StatusSaga.CANCELADA);
  });

  it('compensacao (orcamento rejeitado no Billing): so DELETE /execucao/ordens/{n} — o Billing ja encerrou o orcamento', async () => {
    const { http, saga, eventos, drenar, callback } = novoCenario();
    await drenar();
    await callback('execucao.diagnostico-concluido');
    await callback('billing.orcamento-rejeitado');

    expect(http.chamadas.filter((c) => c.metodo === 'DELETE').map((c) => c.comando)).toEqual(['execucao.liberar-reservas']);
    http.chamadas.forEach((c, i) => conferirChamada(c, CONTRATO[c.comando], eventos[i]));
    expect(saga.status).toBe(StatusSaga.CANCELADA);
  });

  it.each([['execucao.enfileirar' as const], ['execucao.iniciar' as const]])(
    '%s recusado: 409 { motivo } vira execucao.recusada com o motivo',
    async (comando) => {
      const { http, participantes } = novoCenario();
      http.responderCom(comando, 409);
      const r = await participantes.executar({ type: comando, data: { numeroOS: NUMERO_OS, veiculoId: 'vei-0001', descricaoProblema: 'Barulho ao frear' } });
      const [chamada] = http.chamadas;
      conferirChamada(chamada, CONTRATO[comando]);
      expect(r).toEqual({
        entregue: true,
        evento: { type: 'execucao.recusada', data: { numeroOS: NUMERO_OS, motivo: (chamada.resposta as { motivo: string }).motivo } },
      });
    },
  );

  it.each([[200], [409]])(
    'billing.gerar-orcamento com orcamento ativo ja existente (%i com o recurso) = billing.orcamento-gerado',
    async (status) => {
      // http-interno.md admite as duas formas; o OS trata o 409 com o recurso existente como sucesso.
      const { http, participantes } = novoCenario();
      http.responderCom('billing.gerar-orcamento', status, fixtureDeParticipante('billing.gerar-orcamento').respostas['200']);
      const itens = fixtureDeCallback('execucao.diagnostico-concluido').data.itens;
      const r = await participantes.executar({ type: 'billing.gerar-orcamento', data: { numeroOS: NUMERO_OS, clienteId: 'cli-0001', itens } });
      expect(r.entregue).toBe(true);
      conferirChamada(http.chamadas[0], CONTRATO['billing.gerar-orcamento'], r.entregue ? r.evento : undefined);
    },
  );

  it('billing.cancelar-orcamento com pagamento ja aprovado (409): nao entregue — fora do alcance da saga', async () => {
    const { http, participantes } = novoCenario();
    http.responderCom('billing.cancelar-orcamento', 409);
    const r = await participantes.executar({ type: 'billing.cancelar-orcamento', data: { numeroOS: NUMERO_OS, motivo: 'OPERADOR' } });
    conferirChamada(http.chamadas[0], CONTRATO['billing.cancelar-orcamento']);
    expect(r).toMatchObject({ entregue: false, status: 409 });
  });

  it('billing.cobrar recusado (409, orcamento nao aprovado): nao vira evento — a saga fica no passo', async () => {
    const { http, participantes } = novoCenario();
    http.responderCom('billing.cobrar', 409);
    const r = await participantes.executar({ type: 'billing.cobrar', data: { numeroOS: NUMERO_OS } });
    conferirChamada(http.chamadas[0], CONTRATO['billing.cobrar']);
    expect(r).toMatchObject({ entregue: false, status: 409 });
  });
});
