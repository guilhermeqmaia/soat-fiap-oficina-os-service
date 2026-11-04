/**
 * Roda ANTES de qualquer import de modulo de teste (jest `setupFiles`).
 *
 * Garante que variaveis de ambiente sensiveis existam antes de o `AppModule`
 * ser importado — o `validateEnv` do `ConfigModule.forRoot` executa no momento
 * do import, e o CI nao tem arquivo `.env`. Sem isto, specs que importam o
 * AppModule (ex.: app.module.spec.ts) falham com "JWT_SECRET e obrigatorio".
 *
 * Usa `??=` para nao sobrescrever valores reais ja definidos pelo ambiente.
 */
process.env.JWT_SECRET ??= 'test-jwt-secret-ci-0123456789abcdef-strong';
process.env.NODE_ENV ??= 'test';
// Participantes da saga por HTTP (US-F4-18): nos e2e o gateway e substituido por
// um fake em memoria; as URLs so precisam existir para o modulo subir.
process.env.EXECUCAO_SERVICE_URL ??= 'http://localhost:3002';
process.env.BILLING_SERVICE_URL ??= 'http://localhost:3001';
// Relogio da saga e purga de callbacks ficam parados nos testes (chamados direto).
process.env.AGENDADORES_AUTOSTART ??= 'false';
