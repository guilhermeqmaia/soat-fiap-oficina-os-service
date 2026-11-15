import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiBearerAuth, OpenAPIObject } from '@nestjs/swagger';
import {
  DIRETORIO_SCHEMAS,
  SCHEMA_ENVELOPE_CALLBACK,
  anexarContratosHttp,
  criarDocumentoOpenApi,
  marcarRotasPublicas,
  nomeDoComponente,
  paraOpenApi30,
} from './openapi';
import { EXTENSAO_ROTA_PUBLICA, RotaPublica } from '../shared/infrastructure/rota-publica.decorator';

@ApiBearerAuth()
@Controller('exemplo')
class ExemploController {
  @Get()
  protegida() {
    return {};
  }

  @Get('publica')
  @RotaPublica()
  publica() {
    return {};
  }
}

const documento = (paths: OpenAPIObject['paths'], schemas: Record<string, object> = {}): OpenAPIObject =>
  ({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths, components: { schemas } }) as OpenAPIObject;

describe('openapi (US-F4-15)', () => {
  describe('nomeDoComponente', () => {
    it('mapeia $defs, refs locais e raizes de arquivo', () => {
      expect(nomeDoComponente('eventos.schema.json#/$defs/ExecucaoFinalizada', 'callbacks.schema.json')).toBe('ExecucaoFinalizada');
      expect(nomeDoComponente('#/$defs/Dinheiro', 'comum.schema.json')).toBe('Dinheiro');
      expect(nomeDoComponente('envelope.schema.json', 'callbacks.schema.json')).toBe('Envelope');
      expect(nomeDoComponente('#', 'callbacks.schema.json')).toBe(SCHEMA_ENVELOPE_CALLBACK);
    });

    it('falha para ref sem component', () => {
      expect(() => nomeDoComponente('comum.schema.json', 'eventos.schema.json')).toThrow(/sem component/);
      expect(() => nomeDoComponente('x.json#/properties/a', 'eventos.schema.json')).toThrow(/sem component/);
    });
  });

  describe('paraOpenApi30', () => {
    it('converte $ref, examples, type anulavel e remove palavras do JSON Schema', () => {
      const convertido = paraOpenApi30(
        {
          $schema: 'http://json-schema.org/draft-07/schema#',
          $id: 'x',
          $comment: 'c',
          $defs: { A: {} },
          type: 'object',
          properties: {
            a: { $ref: 'comum.schema.json#/$defs/Dinheiro', examples: ['1.00'] },
            b: { type: ['string', 'null'] },
            c: { type: ['integer'] },
            d: { allOf: [{ $ref: 'envelope.schema.json' }] },
          },
        },
        'eventos.schema.json',
      );
      expect(convertido).toEqual({
        type: 'object',
        properties: {
          a: { $ref: '#/components/schemas/Dinheiro', example: '1.00' },
          b: { type: 'string', nullable: true },
          c: { type: 'integer' },
          d: { allOf: [{ $ref: '#/components/schemas/Envelope' }] },
        },
      });
    });

    it('recusa uniao de tipos sem equivalente no OpenAPI 3.0', () => {
      expect(() => paraOpenApi30({ type: ['string', 'integer'] }, 'x.json')).toThrow(/sem equivalente/);
    });
  });

  describe('anexarContratosHttp', () => {
    it('anexa o EnvelopeCallback e o fecho transitivo dos $ref, com discriminator por type', () => {
      const doc = anexarContratosHttp(
        documento({ '/e': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/EnvelopeCallback' } } } }, responses: {} } } }),
      );
      const schemas = doc.components!.schemas as Record<string, Record<string, unknown>>;
      expect(Object.keys(schemas)).toEqual(expect.arrayContaining(['EnvelopeCallback', 'Envelope', 'EnvelopeExecucaoFinalizada', 'ExecucaoFinalizada', 'Item', 'Dinheiro', 'NumeroOS']));
      // respostas dos participantes nao fazem parte da API do OS Service
      expect(schemas.BillingCobrancaCriada).toBeUndefined();
      expect((schemas.EnvelopeCallback.discriminator as { mapping: Record<string, string> }).mapping['execucao.finalizada']).toBe(
        '#/components/schemas/EnvelopeExecucaoFinalizada',
      );
      expect(Object.keys(schemas)).toEqual([...Object.keys(schemas)].sort((a, b) => a.localeCompare(b)));
    });

    it('nao mexe em documento que nao referencia os contratos', () => {
      const doc = anexarContratosHttp({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} } as OpenAPIObject);
      expect(doc.components!.schemas).toEqual({});
    });

    const copiaDosSchemas = (alterar: (arquivo: string, json: Record<string, any>) => void): string => {
      const dir = mkdtempSync(join(tmpdir(), 'schemas-'));
      for (const arquivo of readdirSync(DIRETORIO_SCHEMAS)) {
        const json = JSON.parse(readFileSync(join(DIRETORIO_SCHEMAS, arquivo), 'utf8'));
        alterar(arquivo, json);
        writeFileSync(join(dir, arquivo), JSON.stringify(json));
      }
      return dir;
    };
    const refCallback = documento({ '/e': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/EnvelopeCallback' } } } }, responses: {} } } });

    it('falha com $def duplicado entre arquivos', () => {
      const dir = copiaDosSchemas((arquivo, json) => {
        if (arquivo === 'eventos.schema.json') json.$defs.Item = { type: 'object' };
      });
      expect(() => anexarContratosHttp(structuredClone(refCallback), dir)).toThrow(/duplicado/);
    });

    it('falha quando um component referencia algo que nao existe', () => {
      const dir = copiaDosSchemas((arquivo, json) => {
        if (arquivo === 'eventos.schema.json') json.$defs.ExecucaoFinalizada.properties.extra = { $ref: '#/$defs/NaoExiste' };
      });
      expect(() => anexarContratosHttp(structuredClone(refCallback), dir)).toThrow(/NaoExiste/);
    });
  });

  describe('marcarRotasPublicas', () => {
    it('@RotaPublica e rotas do kit viram security: [] ; rotas com bearer ficam como estao', () => {
      const doc = documento({
        '/health/ready': { get: { responses: {} } },
        '/metrics': { get: { responses: {} } },
        '/status': { get: { responses: {}, [EXTENSAO_ROTA_PUBLICA]: true, security: [{ bearer: [] }] } as never },
        '/privada': { get: { responses: {}, security: [{ bearer: [] }] } },
      });
      marcarRotasPublicas(doc);
      expect(doc.paths['/health/ready'].get!.security).toEqual([]);
      expect(doc.paths['/metrics'].get!.security).toEqual([]);
      expect(doc.paths['/status'].get!.security).toEqual([]);
      expect(doc.paths['/status'].get).not.toHaveProperty(EXTENSAO_ROTA_PUBLICA);
      expect(doc.paths['/privada'].get!.security).toEqual([{ bearer: [] }]);
    });

    it('falha para rota deste servico sem seguranca documentada', () => {
      const doc = documento({ '/healthz': { get: { responses: {} } } });
      expect(() => marcarRotasPublicas(doc)).toThrow(/GET \/healthz sem @ApiBearerAuth/);
    });

    it('ignora entradas do path item que nao sao operacoes', () => {
      const doc = documento({ '/x': { parameters: [], summary: 's' } as never });
      expect(() => marcarRotasPublicas(doc)).not.toThrow();
    });
  });

  it('criarDocumentoOpenApi: versao do package.json, info antes de paths e rota publica sem bearer', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ExemploController] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    const doc = criarDocumentoOpenApi(app);
    expect(doc.info.version).toBe(require('../../package.json').version);
    expect(Object.keys(doc).slice(0, 2)).toEqual(['openapi', 'info']);
    expect(doc.paths['/exemplo'].get!.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/exemplo/publica'].get!.security).toEqual([]);
    await app.close();
  });
});
