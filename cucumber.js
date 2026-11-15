/**
 * Cucumber (US-F4-14) — Gherkin em portugues, steps em TypeScript via ts-node.
 *
 *   npm run test:bdd       -> perfil `default`: nivel de servico (Nest em memoria +
 *                             Postgres Testcontainers + stubs HTTP da Execucao/Billing)
 *                             features/*.feature
 *   npm run test:bdd:e2e   -> perfil `e2e`: ponta a ponta contra o docker-compose.fase4.yml
 *                             (npm run e2e:up), so por HTTP — features/e2e/
 *                             BDD_E2E_REAIS=1 pula os cenarios @stub (imagens reais)
 *
 * Relatorios HTML e JSON em reports/cucumber/. Guia: docs/bdd/README.md.
 */
process.env.TS_NODE_PROJECT ??= 'features/tsconfig.json';

const comum = {
  requireModule: ['ts-node/register'],
  language: 'pt',
  formatOptions: { snippetInterface: 'async-await' },
  strict: true,
};

const suporteComum = ['features/support/*.ts', 'features/step-definitions/*.ts'];

module.exports = {
  default: {
    ...comum,
    paths: ['features/*.feature'],
    require: [...suporteComum, 'features/support/servico/**/*.ts'],
    format: [
      'pretty',
      'html:reports/cucumber/os-service.html',
      'json:reports/cucumber/os-service.json',
    ],
  },
  e2e: {
    ...comum,
    paths: ['features/e2e/**/*.feature'],
    // 00-env primeiro: fixa o JWT_SECRET do compose antes de features/support/env.ts
    require: ['features/support/e2e/00-env.ts', ...suporteComum, 'features/support/e2e/**/*.ts', 'features/step-definitions/e2e/**/*.ts'],
    tags: process.env.BDD_E2E_REAIS ? 'not @stub' : '',
    format: [
      'pretty',
      'html:reports/cucumber/e2e.html',
      'json:reports/cucumber/e2e.json',
    ],
  },
};
