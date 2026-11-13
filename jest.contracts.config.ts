import type { Config } from 'jest';

/**
 * US-F4-15 — testes de contrato (npm run test:contracts, parte de `npm test`).
 * Sem banco nem rede: o provedor sobe o AppModule com Prisma e saga em memoria;
 * o consumidor grava as requisicoes do HttpParticipantesSaga num cliente falso.
 */
const config: Config = {
  displayName: 'contracts',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/test/contracts'],
  testRegex: '.*\\.contract\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json' }] },
  setupFiles: ['<rootDir>/src/test/jest-setup-env.ts'],
  testEnvironment: 'node',
  testTimeout: 30000,
};

export default config;
