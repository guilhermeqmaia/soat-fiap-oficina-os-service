import type { UrlsParticipantes } from '../ordem-de-servico/saga/infrastructure/http-participantes-saga';

/**
 * Enderecos internos dos participantes da saga (RFC-0008, `docs/contratos/http-interno.md`).
 * Em producao vem do ConfigMap com o DNS do cluster (`http://execucao-service:3002`,
 * `http://billing-service:3001`) e sao obrigatorios (`validateEnv`); em dev, `localhost`.
 */
export function urlsDosParticipantes(env: NodeJS.ProcessEnv = process.env): UrlsParticipantes {
  const semBarra = (url: string) => url.replace(/\/+$/, '');
  return {
    execucao: semBarra(env.EXECUCAO_SERVICE_URL || 'http://localhost:3002'),
    billing: semBarra(env.BILLING_SERVICE_URL || 'http://localhost:3001'),
  };
}

/** Timeout por tentativa e tentativas do `ClienteHttpInterno` (defaults do kit: 5 s / 3). */
export function httpInternoConfig(env: NodeJS.ProcessEnv = process.env): { timeoutMs?: number; tentativas?: number } {
  const positivo = (v?: string) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  return { timeoutMs: positivo(env.HTTP_INTERNO_TIMEOUT_MS), tentativas: positivo(env.HTTP_INTERNO_TENTATIVAS) };
}
