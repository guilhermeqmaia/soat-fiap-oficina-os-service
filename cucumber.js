/**
 * Cucumber (US-F4-14) — Gherkin em portugues, steps em TypeScript via ts-node.
 *
 *   npm run test:bdd       -> perfil `default`: nivel de servico (Nest em memoria +
 *                             Postgres Testcontainers + stubs HTTP da Execucao/Billing)
 *   npm run test:bdd:e2e   -> perfil `e2e`: ponta a ponta contra os 3 servicos no
 *                             docker-compose do hub (features em e2e/features/)
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

const suporteComum = ['features/support/*.ts', 'features/step-definitions/**/*.ts'];

module.exports = {
  default: {
    ...comum,
    paths: ['features/**/*.feature'],
    require: [...suporteComum, 'features/support/servico/**/*.ts'],
    format: [
      'pretty',
      'html:reports/cucumber/os-service.html',
      'json:reports/cucumber/os-service.json',
    ],
  },
  e2e: {
    ...comum,
    paths: ['e2e/features/**/*.feature'],
    require: [...suporteComum, 'features/support/e2e/**/*.ts'],
    format: [
      'pretty',
      'html:reports/cucumber/e2e.html',
      'json:reports/cucumber/e2e.json',
    ],
  },
};
