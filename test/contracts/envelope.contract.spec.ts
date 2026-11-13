import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  DIRETORIO_SCHEMAS,
  endpointsParticipantes,
  fixtureDeCallback,
  fixturesDeCallback,
  requisicaoConfereComOpenApi,
  schema,
  valida,
} from './support/contratos';

/**
 * US-F4-15 — fixtures de todos os callbacks que o OS Service recebe validam
 * contra o envelope + `data` do type, nos JSON Schemas e no OpenAPI publicado.
 */
const CALLBACKS = [
  'billing.orcamento-aprovado',
  'billing.orcamento-rejeitado',
  'billing.pagamento-aprovado',
  'billing.pagamento-recusado',
  'execucao.diagnostico-concluido',
  'execucao.finalizada',
];
const CALLBACK = 'callbacks.schema.json';
const ENVELOPE = 'envelope.schema.json';
const EVENTO = '/ordens-servico/{numero}/eventos';

describe('Contrato do envelope dos callbacks (POST /ordens-servico/{numero}/eventos)', () => {
  it('ha uma fixture por type de callback, com o nome do arquivo = type', () => {
    const fixtures = fixturesDeCallback();
    expect(fixtures.map((f) => f.envelope.type).sort()).toEqual(CALLBACKS);
    for (const { arquivo, envelope } of fixtures) expect(arquivo).toBe(`${envelope.type}.json`);
  });

  describe.each(fixturesDeCallback().map((f) => [f.envelope.type, f.envelope] as const))('%s', (_type, envelope) => {
    it('valida contra o Envelope base', () => {
      expect(valida(ENVELOPE, envelope)).toBe('');
    });
    it('valida contra o schema do callback (envelope + data do type)', () => {
      expect(valida(CALLBACK, envelope)).toBe('');
    });
    it('valida contra o requestBody publicado no OpenAPI (EnvelopeCallback)', () => {
      expect(requisicaoConfereComOpenApi(EVENTO, 'post', envelope)).toBe('');
    });
  });

  describe('rejeita envelopes fora do contrato', () => {
    const base = () => fixtureDeCallback('execucao.finalizada');
    const casos: Array<[string, (e: ReturnType<typeof base>) => unknown]> = [
      ['sem id', ({ id: _id, ...resto }) => resto],
      ['id que nao e uuid', (e) => ({ ...e, id: 'abc' })],
      ['sem version', ({ version: _v, ...resto }) => resto],
      ['version 0', (e) => ({ ...e, version: 0 })],
      ['occurredAt invalido', (e) => ({ ...e, occurredAt: 'ontem' })],
      ['producer desconhecido', (e) => ({ ...e, producer: 'outro-service' })],
      ['data que nao e objeto', (e) => ({ ...e, data: 'x' })],
      ['type fora do padrao <dominio>.<fato>', (e) => ({ ...e, type: 'Execucao_Finalizada' })],
    ];
    it.each(casos)('Envelope: %s', (_caso, mutar) => {
      expect(valida(ENVELOPE, mutar(base()))).not.toBe('');
      expect(valida(CALLBACK, mutar(base()))).not.toBe('');
    });

    it('type valido no envelope mas que nao chega por callback (resposta sincrona)', () => {
      const e = { ...base(), type: 'execucao.iniciada' };
      expect(valida(ENVELOPE, e)).toBe('');
      expect(valida(CALLBACK, e)).not.toBe('');
      expect(requisicaoConfereComOpenApi(EVENTO, 'post', e)).not.toBe('');
    });

    it('producer trocado (execucao.* enviado pelo billing)', () => {
      expect(valida(CALLBACK, { ...base(), producer: 'billing-service' })).not.toBe('');
    });

    it.each([
      ['execucao.diagnostico-concluido', 'itens', []],
      ['execucao.diagnostico-concluido', 'diagnostico', 'curt'],
      ['execucao.finalizada', 'finalizadaEm', undefined],
      ['billing.pagamento-aprovado', 'valor', 300],
      ['billing.pagamento-aprovado', 'valor', '300.0'],
      ['billing.orcamento-aprovado', 'orcamentoId', undefined],
      ['billing.pagamento-recusado', 'motivo', undefined],
    ])('%s com data.%s = %j', (type, campo, valor) => {
      const e = fixtureDeCallback(type);
      if (valor === undefined) delete e.data[campo];
      else e.data[campo] = valor;
      expect(valida(CALLBACK, e)).not.toBe('');
    });

    it('item de diagnostico com preco em float (Dinheiro e string com 2 casas)', () => {
      const e = fixtureDeCallback('execucao.diagnostico-concluido');
      (e.data.itens as Array<Record<string, unknown>>)[0].precoUnitario = 150;
      expect(valida(CALLBACK, e)).not.toBe('');
    });
  });

  it('campo novo opcional no envelope ou no data continua valido (mudanca minor)', () => {
    const e = { ...fixtureDeCallback('billing.pagamento-aprovado'), traceparent: '00-abc-def-01' };
    e.data = { ...e.data, metodo: 'pix' };
    expect(valida(CALLBACK, e)).toBe('');
  });
});

describe('Coerencia entre os schemas, o http-interno.md e o asyncapi.yaml', () => {
  const asyncapi = parse(readFileSync(join(DIRETORIO_SCHEMAS, '../asyncapi.yaml'), 'utf8')) as {
    components: { messages: Record<string, { name: string; payload: unknown }> };
  };
  const dataDoAsyncapi = (type: string): { required?: string[] } => {
    const msg = Object.values(asyncapi.components.messages).find((m) => m.name === type);
    if (!msg) throw new Error(`type ${type} ausente do asyncapi.yaml`);
    const partes = (msg.payload as { allOf: Array<{ properties?: { data?: unknown } }> }).allOf;
    const data = partes.find((p) => p.properties?.data)?.properties?.data as { required?: string[]; $ref?: string };
    return data.$ref ? { required: ['numeroOS'] } : data;
  };
  const defDoEvento = (type: string) => type.split(/[.-]/).map((p) => p[0].toUpperCase() + p.slice(1)).join('');

  const eventos = new Set<string>([...CALLBACKS]);
  for (const ep of Object.values(endpointsParticipantes())) {
    for (const r of Object.values(ep.respostas)) if (r.evento && r.schema.startsWith('eventos')) eventos.add(r.evento);
  }

  it.each([...eventos].sort())('%s: campos obrigatorios do data iguais aos do asyncapi.yaml', (type) => {
    const nosso = JSON.parse(readFileSync(join(DIRETORIO_SCHEMAS, 'eventos.schema.json'), 'utf8')).$defs[defDoEvento(type)];
    expect(nosso).toBeDefined();
    expect([...nosso.required].sort()).toEqual([...(dataDoAsyncapi(type).required ?? [])].sort());
  });

  it('todos os schemas compilam e as referencias entre arquivos resolvem', () => {
    for (const ref of ['comum.schema.json', ENVELOPE, 'eventos.schema.json', CALLBACK, 'comandos.schema.json']) {
      expect(() => schema(ref)).not.toThrow();
    }
  });
});
