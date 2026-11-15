import type { Config } from 'jest';

const config: Config = {
  displayName: 'unit',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '^(?!.*\\.(integration|e2e)\\.spec\\.ts$).*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  setupFiles: ['<rootDir>/test/jest-setup-env.ts'],
  collectCoverageFrom: [
    '**/*.ts',
    '!**/generated/**',
    '!main.ts',
    '!**/*.module.ts',
    '!**/test/**',
    '!**/testing/**', // fabrica de tokens p/ testes/dev — nao e codigo de producao
    '!**/*.spec.ts',
  ],
  coverageDirectory: '../coverage/unit',
  // Padrao do jest + json-summary (lido pelo passo "Check coverage gate (80%)" do CI).
  coverageReporters: ['json', 'lcov', 'text', 'clover', 'json-summary'],
  coverageThreshold: {
    global: {
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
    },
  },
  testEnvironment: 'node',
};

export default config;
