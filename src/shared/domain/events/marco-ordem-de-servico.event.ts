import { DomainEvent } from '@guilhermeqmaia/oficina-kit/core';

/**
 * Fatos da OS que interessam ao cliente (US-F4-12). Os `billing.*` usam o
 * vocabulario de `docs/contratos/http-interno.md` (resposta sincrona ou
 * callback do Billing); `os.finalizada`/`os.cancelada` sao as transicoes locais.
 */
export type TipoMarcoOS =
  | 'billing.orcamento-gerado'
  | 'billing.orcamento-aprovado'
  | 'billing.cobranca-criada'
  | 'billing.pagamento-aprovado'
  | 'billing.pagamento-recusado'
  | 'os.finalizada'
  | 'os.cancelada';

export const TIPOS_MARCO_BILLING: ReadonlySet<string> = new Set<TipoMarcoOS>([
  'billing.orcamento-gerado',
  'billing.orcamento-aprovado',
  'billing.cobranca-criada',
  'billing.pagamento-aprovado',
  'billing.pagamento-recusado',
]);

export interface DadosMarcoOS {
  /** `billing.cobranca-criada`: link do Mercado Pago vindo do `201` de `POST /orcamentos/{n}/cobrar`. */
  linkPagamento?: string;
  /** `billing.orcamento-gerado`: total calculado pelo Billing. */
  total?: number;
  diagnostico?: string;
  /** `billing.pagamento-recusado` / `os.cancelada`. */
  motivo?: string;
  valor?: string;
}

/**
 * Marco da OS publicado no `EventEmitter` local SOMENTE depois do commit da
 * saga (o orquestrador acumula os eventos da transacao e descarrega apos o
 * commit) e somente quando a saga aceitou o fato (`aplicado = true`; callback
 * duplicado ou fora de ordem nao gera marco).
 *
 * `eventoId` identifica o fato para a deduplicacao da notificacao: o `id` do
 * envelope do callback; para respostas sincronas (sem envelope), um id
 * deterministico derivado do recurso criado (`orderId`, `orcamentoId`); para
 * as transicoes terminais, `os.finalizada:{numero}` / `os.cancelada:{numero}`
 * (acontecem no maximo uma vez por OS).
 */
export class MarcoOrdemDeServicoEvent extends DomainEvent {
  static readonly EVENT_NAME = 'os.marco';
  readonly eventName = MarcoOrdemDeServicoEvent.EVENT_NAME;

  constructor(
    public readonly type: TipoMarcoOS,
    public readonly numeroOS: string,
    public readonly ordemDeServicoId: string,
    public readonly clienteId: string,
    public readonly eventoId: string,
    public readonly dados: DadosMarcoOS = {},
  ) {
    super();
  }
}
