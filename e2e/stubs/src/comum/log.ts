/**
 * Log JSON de uma linha, com os mesmos campos do os-service (`servico`,
 * `correlation_id`, `trace_id`, `rota`, `tentativa`): `docker compose logs`
 * filtrado pelo numero da OS mostra os tres servicos juntos.
 */
export type Nivel = 'debug' | 'info' | 'warn' | 'error';

const PESO: Record<Nivel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function criarLog(servico: string) {
  const minimo = PESO[(process.env.LOG_LEVEL as Nivel) ?? 'info'] ?? PESO.info;
  const escrever = (nivel: Nivel, msg: string, campos: Record<string, unknown> = {}) => {
    if (PESO[nivel] < minimo) return;
    const linha = { level: nivel, time: new Date().toISOString(), servico, stub: true, msg, ...campos };
    (nivel === 'error' || nivel === 'warn' ? process.stderr : process.stdout).write(JSON.stringify(linha) + '\n');
  };
  return {
    debug: (msg: string, campos?: Record<string, unknown>) => escrever('debug', msg, campos),
    info: (msg: string, campos?: Record<string, unknown>) => escrever('info', msg, campos),
    warn: (msg: string, campos?: Record<string, unknown>) => escrever('warn', msg, campos),
    error: (msg: string, campos?: Record<string, unknown>) => escrever('error', msg, campos),
  };
}

export type Log = ReturnType<typeof criarLog>;

/** `traceparent` W3C -> trace id (32 hex), para o campo `trace_id` do log. */
export function traceIdDe(traceparent: string | undefined): string | undefined {
  const m = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(traceparent ?? '');
  return m?.[1];
}
