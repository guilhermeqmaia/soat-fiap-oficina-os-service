/**
 * Perfil `e2e`: carregado ANTES de features/support/env.ts (primeiro item do
 * `require` em cucumber.js) para que o `??=` de la nao troque o segredo do
 * compose pelo de teste. Tudo pode ser sobrescrito pelo ambiente.
 */
process.env.JWT_SECRET ??= 'e2e-fase4-jwt-secret-0123456789abcdef-local';
// Chamadas com 5xx passam pelo retry do OS (200 + 800 ms) e callbacks pelo dos stubs.
process.env.BDD_TIMEOUT_MS ??= '20000';
process.env.BDD_INTERVALO_MS ??= '200';

export const URLS_E2E = {
  os: (process.env.BDD_OS_SERVICE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  billing: (process.env.BDD_BILLING_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
  execucao: (process.env.BDD_EXECUCAO_URL ?? 'http://localhost:3002').replace(/\/+$/, ''),
  mailpit: (process.env.BDD_MAILPIT_URL ?? 'http://localhost:8025').replace(/\/+$/, ''),
} as const;
