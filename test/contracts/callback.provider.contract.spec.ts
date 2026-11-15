import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { isDeepStrictEqual } from 'node:util';
import request from 'supertest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { Role } from '@guilhermeqmaia/oficina-kit/auth';
import { mintServiceToken, mintToken } from '@guilhermeqmaia/oficina-kit/testing';
import { AppModule } from '../../src/app.module';
import { criarDocumentoOpenApi } from '../../src/config/openapi';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrquestradorSagaService } from '../../src/ordem-de-servico/saga/application/orquestrador-saga.service';
import { CALLBACKS_PROCESSADOS, CallbacksProcessados } from '../../src/ordem-de-servico/saga/application/ports/callbacks-processados';
import { SAGA_REPOSITORY } from '../../src/ordem-de-servico/saga/domain/saga.repository';
import { PassoSaga, StatusSaga } from '../../src/ordem-de-servico/saga/domain/saga-os.entity';
import { OrdemDeServicoNotFoundError } from '../../src/ordem-de-servico/domain/errors/ordem-de-servico-not-found.error';
import { ConcurrentModificationError } from '../../src/ordem-de-servico/domain/errors/concurrent-modification.error';
import { ListarNotificacoesUseCase } from '../../src/notificacao/application/use-cases/listar-notificacoes.use-case';
import { ListarNotificacoesPorCpfCnpjUseCase } from '../../src/notificacao/application/use-cases/listar-notificacoes-por-cpf-cnpj.use-case';
import { Notificacao } from '../../src/notificacao/domain/notificacao.entity';
import { CanalNotificacao } from '../../src/notificacao/domain/value-objects/canal-notificacao.vo';
import { StatusNotificacao } from '../../src/notificacao/domain/value-objects/status-notificacao.vo';
import { TipoNotificacao } from '../../src/notificacao/domain/value-objects/tipo-notificacao.vo';
import {
  ARQUIVO_OPENAPI,
  NUMERO_OS,
  fixtureDeCallback,
  fixturesDeCallback,
  openapi,
  respostaConfereComOpenApi,
} from './support/contratos';

/**
 * US-F4-15 — lado PROVEDOR: respostas reais do OS Service (controller, guards
 * JWT/roles, ValidationPipe, DomainExceptionFilter e ReceberCallbackUseCase de
 * verdade) validam contra docs/contratos/openapi/os-service.yaml. Sem banco:
 * Prisma, orquestrador e repositorios da saga ficam em memoria — o
 * comportamento da saga em si e coberto pelos e2e/BDD.
 */
const EVENTO = '/ordens-servico/{numero}/eventos';
const CPF = '12345678909';

class ProcessadosEmMemoria implements CallbacksProcessados {
  readonly ids = new Set<string>();
  async jaProcessado(id: string) {
    return this.ids.has(id);
  }
  async marcar(id: string) {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    return true;
  }
  async purgar() {
    return 0;
  }
}

function notificacao(over: Partial<Parameters<typeof Notificacao.reconstitute>[0]> = {}): Notificacao {
  return Notificacao.reconstitute({
    id: '0192f3a0-0000-7000-8000-000000000001',
    clienteId: 'cli-0001',
    ordemDeServicoId: '0192f3a0-0000-7000-8000-0000000000aa',
    numeroOS: NUMERO_OS,
    eventoId: '0192f3a0-7c6e-7d2a-9b1e-3f4c5d6e7f02',
    linkPagamento: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123456789-abc',
    tipo: TipoNotificacao.PAGAMENTO_PENDENTE,
    canal: CanalNotificacao.WEBHOOK,
    destinatario: 'https://hooks.example.test/oficina',
    assunto: 'Pagamento pendente',
    mensagem: 'Seu veiculo esta pronto. Pague pelo link.',
    status: StatusNotificacao.ENVIADA,
    erro: null,
    enviadaEm: new Date('2026-11-04T15:31:00.000Z'),
    createdAt: new Date('2026-11-04T15:30:30.000Z'),
    ...over,
  });
}

describe('Contrato do provedor (OS Service) — respostas reais x OpenAPI publicado', () => {
  let app: INestApplication;
  const processados = new ProcessadosEmMemoria();
  const orquestrador = { processarEvento: jest.fn() };
  const sagas = { findByNumero: jest.fn(), save: jest.fn(), deleteByNumero: jest.fn() };
  const notificacoes = [
    notificacao(),
    notificacao({ id: '0192f3a0-0000-7000-8000-000000000002', tipo: TipoNotificacao.ORCAMENTO_PRONTO, canal: CanalNotificacao.EMAIL, linkPagamento: null, destinatario: 'm***@exemplo.com' }),
    // notificacao anterior a US-F4-12: sem numeroOS/eventoId/linkPagamento
    notificacao({ id: '0192f3a0-0000-7000-8000-000000000003', numeroOS: null, eventoId: null, linkPagamento: null, status: StatusNotificacao.FALHOU, erro: 'timeout', enviadaEm: null }),
  ];
  const listar = { execute: jest.fn(async () => ({ data: notificacoes, total: 3, page: 1, limit: 10 })) };
  const tokens = {
    execucao: mintServiceToken({ servico: 'execucao-service' }),
    billing: mintServiceToken({ servico: 'billing-service' }),
    atendente: mintToken({ sub: 'u-atendente', role: Role.ATENDENTE }),
    admin: mintToken({ sub: 'u-admin', role: Role.ADMIN }),
    cliente: mintToken({ sub: 'cli-0001', role: Role.CLIENTE, cpf: CPF, nome: 'Maria' }),
  };
  const tokenDoProdutor = (producer: string) => (producer === 'billing-service' ? tokens.billing : tokens.execucao);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(OrquestradorSagaService)
      .useValue(orquestrador)
      .overrideProvider(CALLBACKS_PROCESSADOS)
      .useValue(processados)
      .overrideProvider(SAGA_REPOSITORY)
      .useValue(sagas)
      .overrideProvider(ListarNotificacoesUseCase)
      .useValue(listar)
      .overrideProvider(ListarNotificacoesPorCpfCnpjUseCase)
      .useValue(listar)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); // igual ao main.ts
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    processados.ids.clear();
    orquestrador.processarEvento.mockReset();
    orquestrador.processarEvento.mockResolvedValue({
      saga: { passo: PassoSaga.GERAR_ORCAMENTO, status: StatusSaga.EM_ANDAMENTO },
      aplicado: true,
    });
    sagas.findByNumero.mockResolvedValue({ passo: PassoSaga.GERAR_ORCAMENTO, status: StatusSaga.EM_ANDAMENTO });
  });

  const postar = (body: unknown, token?: string, numero = NUMERO_OS) => {
    const req = request(app.getHttpServer()).post(`/ordens-servico/${numero}/eventos`);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body as object);
  };
  const confere = (res: request.Response, caminho = EVENTO, metodo = 'post') =>
    respostaConfereComOpenApi(caminho, metodo, res.status, res.body);

  describe('POST /ordens-servico/{numero}/eventos', () => {
    it.each(fixturesDeCallback().map((f) => [f.envelope.type, f.envelope] as const))(
      'callback valido %s -> 200 { aplicado, passo, status }',
      async (_type, envelope) => {
        const res = await postar(envelope, tokenDoProdutor(envelope.producer));
        expect(res.status).toBe(200);
        expect(confere(res)).toBe('');
        expect(res.body).toEqual({ aplicado: true, passo: PassoSaga.GERAR_ORCAMENTO, status: StatusSaga.EM_ANDAMENTO });
        expect(orquestrador.processarEvento).toHaveBeenCalledWith(
          expect.objectContaining({ id: envelope.id, type: envelope.type, data: expect.objectContaining({ numeroOS: NUMERO_OS }) }),
        );
      },
    );

    it('evento ignorado pela saga (fora de ordem) -> 200 { aplicado: false }', async () => {
      orquestrador.processarEvento.mockResolvedValue({
        saga: { passo: PassoSaga.AGUARDAR_PAGAMENTO, status: StatusSaga.EM_ANDAMENTO },
        aplicado: false,
      });
      const res = await postar(fixtureDeCallback('execucao.finalizada'), tokens.execucao);
      expect(res.status).toBe(200);
      expect(res.body.aplicado).toBe(false);
      expect(confere(res)).toBe('');
    });

    it('callback duplicado (mesmo id) -> 200 { aplicado: false, duplicado: true, passo, status }', async () => {
      const envelope = fixtureDeCallback('billing.pagamento-aprovado');
      expect((await postar(envelope, tokens.billing)).status).toBe(200);
      sagas.findByNumero.mockResolvedValue({ passo: PassoSaga.CONCLUIDA, status: StatusSaga.CONCLUIDA });

      const res = await postar(envelope, tokens.billing);
      expect(res.status).toBe(200);
      expect(confere(res)).toBe('');
      expect(res.body).toEqual({ aplicado: false, duplicado: true, passo: PassoSaga.CONCLUIDA, status: StatusSaga.CONCLUIDA });
      expect(orquestrador.processarEvento).toHaveBeenCalledTimes(1);
    });

    it('OS inexistente -> 404', async () => {
      orquestrador.processarEvento.mockRejectedValue(new OrdemDeServicoNotFoundError('OS-NAO-EXISTE'));
      const res = await postar({ ...fixtureDeCallback('execucao.finalizada'), data: { finalizadaEm: '2026-11-04T15:30:00.000Z' } }, tokens.execucao, 'OS-NAO-EXISTE');
      expect(res.status).toBe(404);
      expect(confere(res)).toBe('');
    });

    it('conflito de versao da OS/saga -> 409 (o participante relê e repete)', async () => {
      orquestrador.processarEvento.mockRejectedValue(new ConcurrentModificationError(NUMERO_OS));
      const envelope = fixtureDeCallback('billing.orcamento-aprovado');
      const res = await postar(envelope, tokens.billing);
      expect(res.status).toBe(409);
      expect(confere(res)).toBe('');
      // nada marcado: a repeticao do mesmo id e processada de novo
      expect(processados.ids.has(envelope.id)).toBe(false);
    });

    it.each([
      ['ATENDENTE', tokens.atendente],
      ['ADMIN', tokens.admin],
      ['CLIENTE', tokens.cliente],
    ])('role errada (%s) -> 403', async (_role, token) => {
      const res = await postar(fixtureDeCallback('execucao.finalizada'), token);
      expect(res.status).toBe(403);
      expect(confere(res)).toBe('');
      expect(orquestrador.processarEvento).not.toHaveBeenCalled();
    });

    it('sem token -> 401', async () => {
      const res = await postar(fixtureDeCallback('execucao.finalizada'));
      expect(res.status).toBe(401);
      expect(confere(res)).toBe('');
    });

    it('envelope invalido (sem id) -> 400', async () => {
      const { id: _id, ...semId } = fixtureDeCallback('execucao.finalizada');
      const res = await postar(semId, tokens.execucao);
      expect(res.status).toBe(400);
      expect(confere(res)).toBe('');
    });

    it('data.numeroOS diferente do {numero} do path -> 400', async () => {
      const res = await postar(fixtureDeCallback('execucao.finalizada'), tokens.execucao, 'OS-2026-999999');
      expect(res.status).toBe(400);
      expect(confere(res)).toBe('');
    });
  });

  describe('notificacoes (campos da US-F4-12 no contrato)', () => {
    const camposNovos = ['numeroOS', 'eventoId', 'linkPagamento'];

    it('GET /notificacoes -> 200 paginado com numeroOS, eventoId, linkPagamento e canal WEBHOOK', async () => {
      const res = await request(app.getHttpServer()).get('/notificacoes').set('Authorization', `Bearer ${tokens.admin}`);
      expect(res.status).toBe(200);
      expect(confere(res, '/notificacoes', 'get')).toBe('');
      expect(res.body.data[0]).toMatchObject({ canal: 'WEBHOOK', numeroOS: NUMERO_OS, linkPagamento: expect.stringMatching(/^https:/) });
    });

    it('GET /clientes/{cpfCnpj}/notificacoes -> 200 paginado; 403 com CPF de outro cliente', async () => {
      const ok = await request(app.getHttpServer()).get(`/clientes/${CPF}/notificacoes`).set('Authorization', `Bearer ${tokens.cliente}`);
      expect(ok.status).toBe(200);
      expect(confere(ok, '/clientes/{cpfCnpj}/notificacoes', 'get')).toBe('');

      const outro = await request(app.getHttpServer()).get('/clientes/98765432100/notificacoes').set('Authorization', `Bearer ${tokens.cliente}`);
      expect(outro.status).toBe(403);
      expect(confere(outro, '/clientes/{cpfCnpj}/notificacoes', 'get')).toBe('');
    });

    it('o schema publicado declara os campos novos e o canal WEBHOOK', () => {
      const dto = openapi.components.schemas.NotificacaoResponseDto as { properties: Record<string, { enum?: string[]; nullable?: boolean }> };
      for (const campo of camposNovos) expect(dto.properties[campo]).toMatchObject({ nullable: true });
      expect(dto.properties.canal.enum).toEqual(expect.arrayContaining(['EMAIL', 'WEBHOOK']));
    });
  });

  describe('documento publicado', () => {
    it('os-service.yaml esta em dia com os controllers (rode npm run openapi:export)', () => {
      const gerado = JSON.parse(JSON.stringify(criarDocumentoOpenApi(app)));
      const publicado = parse(readFileSync(ARQUIVO_OPENAPI, 'utf8'));
      expect(isDeepStrictEqual(gerado, publicado)).toBe(true);
    });

    it('info.version = versao do servico (package.json)', () => {
      expect(openapi.info.version).toBe(require('../../package.json').version);
    });

    it('o callback exige bearer com x-role SERVICO e declara 200/400/401/403/404/409', () => {
      const op = openapi.paths[EVENTO].post as { security: unknown; 'x-role': string; responses: Record<string, unknown> };
      expect(op.security).toEqual([{ bearer: [] }]);
      expect(op['x-role']).toBe('SERVICO');
      expect(Object.keys(op.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409']);
    });
  });
});
