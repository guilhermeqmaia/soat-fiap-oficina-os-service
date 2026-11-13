import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { EXTENSAO_ROTA_PUBLICA } from '../shared/infrastructure/rota-publica.decorator';

/**
 * OpenAPI do OS Service (US-F4-15). Uma unica funcao monta o documento para o
 * Swagger UI (`/api`, main.ts) e para o arquivo publicado no hub
 * (`npm run openapi:export` -> docs/contratos/openapi/os-service.yaml), para que
 * os dois nunca divirjam.
 *
 * O envelope dos callbacks e os payloads por `type` NAO sao reescritos em
 * decorators: vem dos JSON Schemas de `docs/contratos/schemas/` (fonte unica,
 * tambem usada pelos testes de contrato) e sao convertidos para components
 * OpenAPI 3.0 aqui.
 */

/** Component do corpo de `POST /ordens-servico/{numero}/eventos`. */
export const SCHEMA_ENVELOPE_CALLBACK = 'EnvelopeCallback';

export const DIRETORIO_SCHEMAS = resolve(__dirname, '../../docs/contratos/schemas');

type Json = { [k: string]: unknown };

const ARQUIVO_RAIZ: Record<string, string> = {
  'envelope.schema.json': 'Envelope',
  'callbacks.schema.json': SCHEMA_ENVELOPE_CALLBACK,
};

/** `eventos.schema.json#/$defs/Foo` -> `Foo`; raiz de arquivo -> nome do arquivo. */
export function nomeDoComponente(ref: string, arquivoAtual: string): string {
  const [arquivo, ponteiro = ''] = ref.split('#');
  const def = /^\/\$defs\/([A-Za-z0-9]+)$/.exec(ponteiro)?.[1];
  if (def) return def;
  const raiz = ARQUIVO_RAIZ[arquivo || arquivoAtual];
  if (raiz && ponteiro === '') return raiz;
  throw new Error(`$ref sem component OpenAPI correspondente: ${ref} (em ${arquivoAtual})`);
}

/**
 * JSON Schema (draft-07) -> Schema Object do OpenAPI 3.0: `$ref` vira
 * `#/components/schemas/<nome>`, `examples` vira `example`, `type: [x, 'null']`
 * vira `type: x` + `nullable`; `$schema`/`$id`/`$defs`/`$comment` saem.
 */
export function paraOpenApi30(node: unknown, arquivoAtual: string): unknown {
  if (Array.isArray(node)) return node.map((n) => paraOpenApi30(n, arquivoAtual));
  if (!node || typeof node !== 'object') return node;
  const saida: Json = {};
  for (const [chave, valor] of Object.entries(node as Json)) {
    if (['$schema', '$id', '$defs', '$comment'].includes(chave)) continue;
    if (chave === '$ref') {
      saida.$ref = `#/components/schemas/${nomeDoComponente(String(valor), arquivoAtual)}`;
    } else if (chave === 'examples' && Array.isArray(valor)) {
      saida.example = valor[0];
    } else if (chave === 'type' && Array.isArray(valor)) {
      const tipos = valor.filter((t) => t !== 'null');
      if (tipos.length !== 1) throw new Error(`type ${JSON.stringify(valor)} sem equivalente no OpenAPI 3.0 (${arquivoAtual})`);
      saida.type = tipos[0];
      if (valor.includes('null')) saida.nullable = true;
    } else {
      saida[chave] = paraOpenApi30(valor, arquivoAtual);
    }
  }
  return saida;
}

function lerSchema(diretorio: string, arquivo: string): Json {
  return JSON.parse(readFileSync(join(diretorio, arquivo), 'utf8')) as Json;
}

/** Todos os components definidos pelos JSON Schemas (raizes + `$defs`). */
function componentesDosSchemas(diretorio: string): Record<string, Json> {
  const componentes: Record<string, Json> = {};
  for (const arquivo of ['comum.schema.json', 'envelope.schema.json', 'eventos.schema.json', 'callbacks.schema.json']) {
    const schema = lerSchema(diretorio, arquivo);
    for (const [nome, def] of Object.entries((schema.$defs ?? {}) as Record<string, Json>)) {
      if (componentes[nome]) throw new Error(`$def duplicado entre arquivos de schema: ${nome}`);
      componentes[nome] = paraOpenApi30(def, arquivo) as Json;
    }
    const raiz = ARQUIVO_RAIZ[arquivo];
    if (raiz) componentes[raiz] = paraOpenApi30(schema, arquivo) as Json;
  }
  return componentes;
}

function refsDe(node: unknown, achados: Set<string>): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => refsDe(n, achados));
  else if (node && typeof node === 'object') {
    for (const [chave, valor] of Object.entries(node as Json)) {
      if (chave === '$ref' && typeof valor === 'string') achados.add(valor.replace('#/components/schemas/', ''));
      else refsDe(valor, achados);
    }
  }
  return achados;
}

/**
 * Anexa ao documento os components dos contratos referenciados por ele (por
 * `@ApiBody({ schema: { $ref } })`), com o fecho transitivo dos `$ref`. So o que
 * o OS Service expoe entra — as respostas dos participantes ficam nos schemas.
 */
export function anexarContratosHttp(documento: OpenAPIObject, diretorio = DIRETORIO_SCHEMAS): OpenAPIObject {
  const disponiveis = componentesDosSchemas(diretorio);
  const schemas = (documento.components ??= {}).schemas ?? {};
  documento.components.schemas = schemas;
  const pendentes = [...refsDe(documento.paths, new Set())].filter((n) => disponiveis[n] && !schemas[n]);
  while (pendentes.length) {
    const nome = pendentes.pop()!;
    if (schemas[nome]) continue;
    schemas[nome] = disponiveis[nome];
    for (const ref of refsDe(disponiveis[nome], new Set())) {
      if (!disponiveis[ref]) throw new Error(`component ${ref} referenciado por ${nome} nao existe nos schemas`);
      if (!schemas[ref]) pendentes.push(ref);
    }
  }
  const callback = schemas[SCHEMA_ENVELOPE_CALLBACK] as Json | undefined;
  if (callback?.oneOf) {
    // Facilita a renderizacao (Redoc/Swagger UI): cada `type` aponta para a sua variante.
    const mapping: Record<string, string> = {};
    for (const variante of callback.oneOf as Array<{ $ref: string }>) {
      const titulo = (schemas[variante.$ref.replace('#/components/schemas/', '')] as Json).title as string;
      mapping[titulo] = variante.$ref;
    }
    callback.discriminator = { propertyName: 'type', mapping };
  }
  documento.components.schemas = Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b)));
  return documento;
}

/**
 * Seguranca de cada operacao: `@RotaPublica()` vira `security: []`; as rotas do
 * kit (`/health`, `/metrics`, sem decorators Swagger) tambem sao publicas. Uma
 * operacao deste servico sem `@ApiBearerAuth` nem `@RotaPublica` falha aqui —
 * evita publicar como publica uma rota protegida pelo guard global (ou o contrario).
 */
export function marcarRotasPublicas(documento: OpenAPIObject, publicas: readonly string[] = ['/health', '/metrics']): void {
  for (const [caminho, item] of Object.entries(documento.paths)) {
    for (const [metodo, operacao] of Object.entries(item)) {
      if (!operacao || typeof operacao !== 'object' || !('responses' in operacao)) continue;
      const marcada = operacao as Record<string, unknown>;
      if (marcada[EXTENSAO_ROTA_PUBLICA]) {
        delete marcada[EXTENSAO_ROTA_PUBLICA];
        operacao.security = [];
        continue;
      }
      if (operacao.security) continue;
      if (!publicas.some((p) => caminho === p || caminho.startsWith(`${p}/`))) {
        throw new Error(`${metodo.toUpperCase()} ${caminho} sem @ApiBearerAuth: documente a seguranca da rota`);
      }
      operacao.security = [];
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VERSAO_SERVICO: string = require('../../package.json').version;

export function criarDocumentoOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Oficina Mecânica — OS Service')
    .setDescription(
      'Atendimento (clientes, veiculos, ordens de servico), orquestrador da saga e notificacoes. ' +
        'Endpoints internos e callback com JWT role SERVICO (x-role) — contrato em docs/contratos/http-interno.md.',
    )
    .setVersion(VERSAO_SERVICO)
    .setLicense('ISC', 'https://opensource.org/license/isc-license-txt')
    .addServer('http://os-service:3000', 'DNS interno do cluster (chamadas entre servicos; em dev, http://localhost:3000)')
    .addBearerAuth()
    .build();
  const documento = SwaggerModule.createDocument(app, config);
  marcarRotasPublicas(documento);
  const { openapi, info, servers, tags, paths, components, ...resto } = anexarContratosHttp(documento);
  // Ordem de leitura humana (info antes de paths) — o arquivo e revisado em PR.
  return { openapi, info, servers, tags, ...resto, paths, components };
}
