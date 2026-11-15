import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Os mesmos JSON Schemas que os testes de contrato do os-service usam
 * (`docs/contratos/schemas`, US-F4-15). O stub valida:
 * - o corpo que RECEBE do OS (comando) contra `comandos.schema.json`;
 * - a resposta que DEVOLVE contra `endpoints-participantes.json` (status
 *   declarado + schema do corpo);
 * - o envelope do callback que ENVIA contra `callbacks.schema.json`.
 * Qualquer divergencia vira uma "violacao" (log `error` + `GET /__stub/violacoes`).
 */
const BASE_ID = 'https://contratos.oficina-mecanica.local/schemas/';

function acharDiretorio(): string {
  const candidatos = [
    process.env.SCHEMAS_DIR,
    resolve(__dirname, '../../schemas'), // imagem: /app/schemas
    resolve(__dirname, '../../../../docs/contratos/schemas'), // dev: e2e/stubs/dist/comum -> raiz
    resolve(__dirname, '../../../../../docs/contratos/schemas'),
  ].filter((c): c is string => !!c);
  const achado = candidatos.find((c) => existsSync(join(c, 'endpoints-participantes.json')));
  if (!achado) throw new Error(`docs/contratos/schemas nao encontrado (tentado: ${candidatos.join(', ')}). Defina SCHEMAS_DIR.`);
  return achado;
}

export const DIRETORIO_SCHEMAS = acharDiretorio();

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
for (const arquivo of readdirSync(DIRETORIO_SCHEMAS).filter((f) => f.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(join(DIRETORIO_SCHEMAS, arquivo), 'utf8')));
}

export interface EndpointParticipante {
  participante: string;
  metodo: 'POST' | 'DELETE';
  path: string;
  corpo: string | null;
  respostas: Record<string, { schema: string; evento: string | null }>;
}

const { $comment: _c, ...tabela } = JSON.parse(readFileSync(join(DIRETORIO_SCHEMAS, 'endpoints-participantes.json'), 'utf8'));
export const ENDPOINTS = tabela as Record<string, EndpointParticipante>;

function erros(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || '(raiz)'} ${e.message}`).join('; ');
}

/** '' quando confere; senao a lista de erros do ajv. */
export function validar(ref: string, valor: unknown): string {
  const fn = ajv.getSchema(BASE_ID + ref);
  if (!fn) return `schema inexistente: ${ref}`;
  return fn(valor) ? '' : erros(fn.errors);
}

/** Template da rota no formato do contrato: `POST /orcamentos/{numeroOS}/cobrar`. */
export function rotaDoComando(comando: string): string {
  const e = ENDPOINTS[comando];
  return `${e.metodo} ${e.path}`;
}

/**
 * Status que o stub pode devolver fora da tabela sem ser violacao: erros de
 * transporte/autenticacao que todo endpoint tem (`401`/`403`), `400` de corpo
 * invalido, `404` de OS desconhecida e os `5xx` injetados pelo cenario.
 */
const STATUS_GENERICOS = new Set([400, 401, 403, 404]);

export function validarResposta(comando: string, status: number, corpo: unknown): string {
  if (STATUS_GENERICOS.has(status) || status >= 500) return '';
  const declarada = ENDPOINTS[comando]?.respostas[String(status)];
  if (!declarada) {
    return `status ${status} nao declarado para ${comando} (declarados: ${Object.keys(ENDPOINTS[comando]?.respostas ?? {}).join(', ')})`;
  }
  return validar(declarada.schema, corpo);
}

export function validarCorpoDoComando(comando: string, corpo: unknown): string {
  const ref = ENDPOINTS[comando]?.corpo;
  if (!ref) return '';
  return validar(ref, corpo);
}

export function validarEnvelopeCallback(envelope: unknown): string {
  return validar('callbacks.schema.json', envelope);
}
