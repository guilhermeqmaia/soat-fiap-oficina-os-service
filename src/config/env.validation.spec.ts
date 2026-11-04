import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('throws when JWT_SECRET is missing', () => {
    expect(() => validateEnv({})).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET is a known placeholder', () => {
    expect(() =>
      validateEnv({ JWT_SECRET: 'change-me-to-a-strong-random-secret' }),
    ).toThrow(/placeholder/i);
  });

  it('rejects a short secret in production', () => {
    expect(() =>
      validateEnv({ JWT_SECRET: 'short-secret', NODE_ENV: 'production' }),
    ).toThrow(/32/);
  });

  it('accepts a short non-placeholder secret outside production (dev/test)', () => {
    expect(() => validateEnv({ JWT_SECRET: 'test-secret' })).not.toThrow();
  });

  it('accepts a strong secret in production (com as URLs dos participantes)', () => {
    expect(() =>
      validateEnv({ JWT_SECRET: 'a'.repeat(48), NODE_ENV: 'production', EXECUCAO_SERVICE_URL: 'http://execucao-service:3002', BILLING_SERVICE_URL: 'http://billing-service:3001' }),
    ).not.toThrow();
  });
});

describe('validateEnv — URLs dos participantes (US-F4-18)', () => {
  const ok = { JWT_SECRET: 'a'.repeat(48) };
  it('fora de producao sao opcionais', () => {
    expect(() => validateEnv({ ...ok })).not.toThrow();
    expect(() => validateEnv({ ...ok, EXECUCAO_SERVICE_URL: '' })).not.toThrow();
  });
  it('em producao sao obrigatorias', () => {
    expect(() => validateEnv({ ...ok, NODE_ENV: 'production', BILLING_SERVICE_URL: 'http://billing-service:3001' })).toThrow(/EXECUCAO_SERVICE_URL/);
    expect(() => validateEnv({ ...ok, NODE_ENV: 'production', EXECUCAO_SERVICE_URL: 'http://execucao-service:3002', BILLING_SERVICE_URL: 'http://billing-service:3001' })).not.toThrow();
  });
  it('rejeita valor que nao e URL http(s)', () => {
    expect(() => validateEnv({ ...ok, BILLING_SERVICE_URL: 'billing-service:3001' })).toThrow(/BILLING_SERVICE_URL/);
  });
});
