/**
 * US-F4-15 — exporta o OpenAPI do OS Service para o hub, sem banco nem rede:
 * `preview: true` monta o grafo de modulos sem instanciar providers (Prisma nao
 * conecta) e o SwaggerModule le so os metadados dos controllers.
 *
 *   npm run openapi:export            -> grava docs/contratos/openapi/os-service.yaml
 *   npm run openapi:export -- --check -> falha se o arquivo commitado estiver desatualizado
 */
import '../src/test/jest-setup-env';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { stringify } from 'yaml';
import { AppModule } from '../src/app.module';
import { criarDocumentoOpenApi } from '../src/config/openapi';

export const ARQUIVO_OPENAPI = resolve(__dirname, '../docs/contratos/openapi/os-service.yaml');

async function exportar(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
  const yaml = stringify(criarDocumentoOpenApi(app), { lineWidth: 0, aliasDuplicateObjects: false });
  await app.close();

  if (process.argv.includes('--check')) {
    const atual = readFileSync(ARQUIVO_OPENAPI, 'utf8').replace(/\r\n/g, '\n');
    if (atual !== yaml) {
      console.error(`${ARQUIVO_OPENAPI} desatualizado: rode \`npm run openapi:export\` e commite o resultado.`);
      process.exit(1);
    }
    console.log('os-service.yaml em dia com o codigo.');
    return;
  }
  writeFileSync(ARQUIVO_OPENAPI, yaml);
  console.log(`OpenAPI gravado em ${ARQUIVO_OPENAPI}`);
}

exportar().catch((e) => {
  console.error(e);
  process.exit(1);
});
