import { CorrelationContext, getActiveTraceIds, getCorrelationContext, runWithCorrelation } from '@guilhermeqmaia/oficina-kit/logging';

/** Nome deste servico nos logs (`servico`) e nas metricas (`origem`). */
export const SERVICO = 'os-service';

/**
 * Trace corrente: o span ativo do APM (`dd-trace`) quando ligado; senao o
 * `traceId` do contexto da requisicao (o middleware do kit le o `traceparent`
 * recebido — e assim que um callback continua o trace de quem chamou mesmo sem
 * APM nos logs).
 */
export function traceIdAtual(): string | undefined {
  return getActiveTraceIds()?.traceId ?? getCorrelationContext()?.traceId;
}

/**
 * Campos de rastreio da US-F4-16 em toda linha do orquestrador e do callback:
 * `trace_id`, `correlation_id` (numero da OS), `servico` + o que a linha
 * acrescentar (`rota`, `tentativa`, ...). Explicitos (snake_case) porque a
 * linha pode nascer fora de uma requisicao (relogio da saga, reprocessar) — o
 * mixin do kit so poe `correlationId`/`traceId` quando ha contexto, e com o id
 * da requisicao, nao o numero da OS.
 */
export function camposDeRastreio(numeroOS: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const campos: Record<string, unknown> = { trace_id: traceIdAtual(), correlation_id: numeroOS, servico: SERVICO, ...extra };
  for (const k of Object.keys(campos)) if (campos[k] === undefined) delete campos[k];
  return campos;
}

/**
 * Roda `fn` com o numero da OS como `correlationId` do contexto, mantendo o
 * trace corrente. Assim as linhas que o cliente HTTP do kit loga sozinho (ex.:
 * "chamada interna falhou — nova tentativa", com `tentativa`) saem com a OS e o
 * trace pelo mixin do logger, mesmo quando a chamada parte do relogio da saga.
 */
export function comCorrelacaoDaOS<T>(numeroOS: string, fn: () => T): T {
  const ctx: CorrelationContext = { correlationId: numeroOS, traceId: traceIdAtual() ?? numeroOS };
  return runWithCorrelation(ctx, fn);
}
