/**
 * Validacao de variaveis de ambiente, executada no boot via
 * `ConfigModule.forRoot({ validate: validateEnv })`. Falha rapido (fail-fast)
 * se a configuracao de seguranca for fraca/ausente — em vez de subir a aplicacao
 * com um segredo inseguro.
 */

const MIN_SECRET_LENGTH = 32;

/** Valores placeholder conhecidos que nunca podem ser usados como segredo real. */
const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-strong-random-secret',
  'changeme',
  'change-me',
  'secret',
  'your-secret',
]);

/** Enderecos internos dos participantes da saga (RFC-0008): obrigatorios em producao. */
const SERVICE_URL_VARS = ['EXECUCAO_SERVICE_URL', 'BILLING_SERVICE_URL'] as const;
const URL_HTTP = /^https?:\/\/.+/;

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const jwtSecret = config.JWT_SECRET;

  if (typeof jwtSecret !== 'string' || jwtSecret.length === 0) {
    throw new Error(
      'JWT_SECRET e obrigatorio. Defina-o no ambiente antes de iniciar a aplicacao.',
    );
  }

  if (PLACEHOLDER_SECRETS.has(jwtSecret)) {
    throw new Error(
      'JWT_SECRET nao pode usar um valor placeholder. Gere um segredo forte, ex.: `openssl rand -base64 48`.',
    );
  }

  // Em producao exigimos um segredo forte; em dev/test um valor curto e tolerado
  // para nao atritar o fluxo de desenvolvimento e os testes.
  if (config.NODE_ENV === 'production' && jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET deve ter ao menos ${MIN_SECRET_LENGTH} caracteres em producao. Gere com: \`openssl rand -base64 48\`.`,
    );
  }

  for (const nome of SERVICE_URL_VARS) {
    const valor = config[nome];
    if (valor === undefined || valor === '') {
      if (config.NODE_ENV === 'production') {
        throw new Error(`${nome} e obrigatoria em producao (ex.: http://execucao-service:3002).`);
      }
      continue;
    }
    if (!URL_HTTP.test(String(valor))) {
      throw new Error(`${nome} deve ser uma URL http(s) (recebido: ${String(valor)}).`);
    }
  }

  return config;
}
