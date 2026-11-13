import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

/**
 * Validadores dos contratos (US-F4-15):
 * - JSON Schemas de docs/contratos/schemas (envelope, eventos, comandos);
 * - OpenAPI publicado em docs/contratos/openapi/os-service.yaml.
 */
const RAIZ = resolve(__dirname, '../../..');
export const DIRETORIO_SCHEMAS = join(RAIZ, 'docs/contratos/schemas');
export const ARQUIVO_OPENAPI = join(RAIZ, 'docs/contratos/openapi/os-service.yaml');
export const DIRETORIO_FIXTURES = resolve(__dirname, '../fixtures');
const BASE_ID = 'https://contratos.oficina-mecanica.local/schemas/';

export const NUMERO_OS = 'OS-2026-000123';

type Json = Record<string, unknown>;

function novoAjv(): Ajv {
  // strict: false — os schemas carregam anotacoes (examples, discriminator, example do OpenAPI).
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv;
}

const ajvSchemas = novoAjv();
for (const arquivo of readdirSync(DIRETORIO_SCHEMAS).filter((f) => f.endsWith('.schema.json'))) {
  ajvSchemas.addSchema(JSON.parse(readFileSync(join(DIRETORIO_SCHEMAS, arquivo), 'utf8')));
}

export function lerJson<T = Json>(caminho: string): T {
  return JSON.parse(readFileSync(caminho, 'utf8')) as T;
}

/** Validador de um schema dos contratos: `eventos.schema.json#/$defs/ExecucaoIniciada`. */
export function schema(ref: string): ValidateFunction {
  const validar = ajvSchemas.getSchema(BASE_ID + ref);
  if (!validar) throw new Error(`schema inexistente: ${ref}`);
  return validar;
}

export function erros(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || '(raiz)'} ${e.message}`).join('; ');
}

/** `expect(valida(ref, valor)).toBe('')` mostra os erros de schema quando falha. */
export function valida(ref: string, valor: unknown): string {
  const validar = schema(ref);
  return validar(valor) ? '' : erros(validar.errors);
}

export interface EndpointParticipante {
  participante: string;
  metodo: 'POST' | 'DELETE';
  path: string;
  corpo: string | null;
  respostas: Record<string, { schema: string; evento: string | null }>;
}

export function endpointsParticipantes(): Record<string, EndpointParticipante> {
  const { $comment: _ignorado, ...tabela } = lerJson<Record<string, unknown>>(join(DIRETORIO_SCHEMAS, 'endpoints-participantes.json'));
  return tabela as Record<string, EndpointParticipante>;
}

// ---------------------------------------------------------------- OpenAPI

export const openapi = parse(readFileSync(ARQUIVO_OPENAPI, 'utf8')) as {
  info: { version: string };
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
};

const ajvOpenApi = novoAjv();
const cacheOpenApi = new Map<string, ValidateFunction>();

function compilarOpenApi(chave: string, schemaOpenApi: Json): ValidateFunction {
  let validar = cacheOpenApi.get(chave);
  if (!validar) {
    // `#/components/schemas/X` resolve contra a raiz: o schema leva os components junto.
    validar = ajvOpenApi.compile({ ...schemaOpenApi, components: openapi.components });
    cacheOpenApi.set(chave, validar);
  }
  return validar;
}

function operacao(caminho: string, metodo: string): Json {
  const op = openapi.paths[caminho]?.[metodo.toLowerCase()];
  if (!op) throw new Error(`${metodo.toUpperCase()} ${caminho} nao esta no OpenAPI`);
  return op;
}

/**
 * Valida uma resposta real contra o OpenAPI: o status precisa estar declarado na
 * operacao e o corpo precisa bater com o schema dele. Devolve '' quando confere.
 */
export function respostaConfereComOpenApi(caminho: string, metodo: string, status: number, corpo: unknown): string {
  const respostas = operacao(caminho, metodo).responses as Record<string, Json>;
  const declarada = respostas[String(status)];
  if (!declarada) return `status ${status} nao declarado em ${metodo.toUpperCase()} ${caminho} (declarados: ${Object.keys(respostas).join(', ')})`;
  const conteudo = (declarada.content as Record<string, { schema: Json }> | undefined)?.['application/json'];
  if (!conteudo) return corpo === undefined || corpo === '' || (typeof corpo === 'object' && Object.keys(corpo as Json).length === 0) ? '' : `status ${status} sem schema de corpo no OpenAPI`;
  const validar = compilarOpenApi(`${metodo} ${caminho} ${status}`, conteudo.schema);
  return validar(corpo) ? '' : erros(validar.errors);
}

/** Valida um corpo de requisicao contra o requestBody declarado no OpenAPI. */
export function requisicaoConfereComOpenApi(caminho: string, metodo: string, corpo: unknown): string {
  const body = operacao(caminho, metodo).requestBody as { content: Record<string, { schema: Json }> } | undefined;
  if (!body) return `${metodo.toUpperCase()} ${caminho} sem requestBody no OpenAPI`;
  const validar = compilarOpenApi(`${metodo} ${caminho} requestBody`, body.content['application/json'].schema);
  return validar(corpo) ? '' : erros(validar.errors);
}

// ---------------------------------------------------------------- fixtures

export interface FixtureCallback {
  arquivo: string;
  envelope: { id: string; type: string; producer: string; data: Json } & Json;
}

export function fixturesDeCallback(): FixtureCallback[] {
  const dir = join(DIRETORIO_FIXTURES, 'callbacks');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((arquivo) => ({ arquivo, envelope: lerJson(join(dir, arquivo)) as FixtureCallback['envelope'] }));
}

export function fixtureDeCallback(type: string): FixtureCallback['envelope'] {
  const achada = fixturesDeCallback().find((f) => f.envelope.type === type);
  if (!achada) throw new Error(`sem fixture de callback para ${type}`);
  return structuredClone(achada.envelope);
}

export interface FixtureParticipante {
  comando: string;
  respostas: Record<string, unknown>;
}

export function fixtureDeParticipante(comando: string): FixtureParticipante {
  return lerJson(join(DIRETORIO_FIXTURES, 'participantes', `${comando}.json`));
}
