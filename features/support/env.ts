/**
 * Variaveis de ambiente dos testes BDD. Este arquivo e importado no topo dos
 * hooks ANTES do `AppModule` (o `validateEnv` do ConfigModule roda no import).
 * Usa `??=` para nunca sobrescrever o que ja vier do ambiente (CI, perfil e2e).
 */
process.env.JWT_SECRET ??= 'test-jwt-secret-ci-0123456789abcdef-strong';
process.env.NODE_ENV ??= 'test';
// Relogio da saga e purga de callbacks parados (os cenarios disparam o que precisam).
process.env.AGENDADORES_AUTOSTART ??= 'false';
// Sem rate limit: um cenario faz dezenas de chamadas em poucos ms.
process.env.THROTTLER_DISABLED ??= 'true';
// Logs JSON do pino silenciados (BDD_LOG=1 liga para depurar).
process.env.LOG_LEVEL ??= process.env.BDD_LOG ? 'info' : 'silent';
// 5xx/timeout: 3 tentativas com backoff de 200/800 ms (padrao do kit, ~1 s por chamada que falha).
process.env.HTTP_INTERNO_TENTATIVAS ??= '3';
process.env.HTTP_INTERNO_TIMEOUT_MS ??= '2000';

export const BDD = {
  /** Timeout padrao do polling (`aguardarAte`). */
  timeoutMs: Number(process.env.BDD_TIMEOUT_MS ?? 10_000),
  intervaloMs: Number(process.env.BDD_INTERVALO_MS ?? 100),
} as const;
