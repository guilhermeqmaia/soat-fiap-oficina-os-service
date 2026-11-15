import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { startTestDatabase, stopTestDatabase } from '../../test/database.container';
import { Notificacao } from '../domain/notificacao.entity';
import { CanalNotificacao } from '../domain/value-objects/canal-notificacao.vo';
import { StatusNotificacao } from '../domain/value-objects/status-notificacao.vo';
import { TipoNotificacao } from '../domain/value-objects/tipo-notificacao.vo';
import { PrismaNotificacaoRepository } from './prisma-notificacao.repository';

jest.setTimeout(60000);

describe('PrismaNotificacaoRepository (integration)', () => {
  let prisma: PrismaService;
  let repo: PrismaNotificacaoRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = await startTestDatabase();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService, PrismaNotificacaoRepository],
    }).compile();
    prisma = module.get(PrismaService);
    repo = module.get(PrismaNotificacaoRepository);
    await prisma.onModuleInit();
  });
  beforeEach(async () => {
    await prisma.notificacao.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await stopTestDatabase();
  });

  const nova = (over: Partial<Parameters<typeof Notificacao.create>[0]> = {}) =>
    Notificacao.create({
      clienteId: 'cli-1',
      ordemDeServicoId: 'os-1',
      numeroOS: 'OS-2026-000001',
      eventoId: 'env-1',
      tipo: TipoNotificacao.PAGAMENTO_PENDENTE,
      canal: CanalNotificacao.EMAIL,
      destinatario: 'cliente@email.com',
      assunto: 'Pague para retirar',
      mensagem: 'Link: https://mp.test/pay/mp-1',
      linkPagamento: 'https://mp.test/pay/mp-1',
      ...over,
    });

  it('create grava e devolve com as colunas novas (numero_os, evento_id, link_pagamento)', async () => {
    const salva = await repo.create(nova());

    expect(salva.id).toBeDefined();
    expect(salva.createdAt).toBeInstanceOf(Date);
    const lida = (await repo.findById(salva.id!))!;
    expect(lida).toMatchObject({
      numeroOS: 'OS-2026-000001',
      eventoId: 'env-1',
      linkPagamento: 'https://mp.test/pay/mp-1',
      tipo: TipoNotificacao.PAGAMENTO_PENDENTE,
      canal: CanalNotificacao.EMAIL,
      status: StatusNotificacao.PENDENTE,
    });
  });

  it('findById inexistente -> null', async () => {
    expect(await repo.findById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('reservar: mesmo (eventoId, tipo, canal) -> null (ja notificado), sem segunda linha', async () => {
    expect(await repo.reservar(nova())).not.toBeNull();
    expect(await repo.reservar(nova({ mensagem: 'reenvio' }))).toBeNull();
    expect(await prisma.notificacao.count()).toBe(1);
  });

  it('indice unico: create direto do mesmo fato viola a constraint notificacao_evento_id_tipo_canal_key', async () => {
    await repo.create(nova());
    await expect(repo.create(nova())).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a chave e (eventoId, tipo, canal): outro tipo, outro canal ou outro evento NAO conflitam', async () => {
    await repo.reservar(nova());
    expect(await repo.reservar(nova({ tipo: TipoNotificacao.PAGAMENTO_APROVADO }))).not.toBeNull();
    expect(await repo.reservar(nova({ canal: CanalNotificacao.WEBHOOK }))).not.toBeNull();
    expect(await repo.reservar(nova({ eventoId: 'env-2' }))).not.toBeNull();
    expect(await prisma.notificacao.count()).toBe(4);
  });

  it('sem eventoId (notificacoes antigas) nao ha deduplicacao: NULLs sao distintos', async () => {
    expect(await repo.reservar(nova({ eventoId: null }))).not.toBeNull();
    expect(await repo.reservar(nova({ eventoId: null }))).not.toBeNull();
    expect(await prisma.notificacao.count()).toBe(2);
  });

  it('reservar propaga erros que nao sao de unicidade', async () => {
    // clienteId obrigatorio (NOT NULL) -> erro do banco que nao e "ja notificado"
    await expect(repo.reservar(nova({ clienteId: null as unknown as string }))).rejects.toBeDefined();
  });

  it('atualizarResultado grava ENVIADA/FALHOU, erro e enviadaEm', async () => {
    const reservada = (await repo.reservar(nova()))!;
    reservada.marcarComoEnviada(new Date('2026-11-10T12:00:00.000Z'));
    const enviada = await repo.atualizarResultado(reservada);
    expect(enviada.status).toBe(StatusNotificacao.ENVIADA);
    expect(enviada.enviadaEm?.toISOString()).toBe('2026-11-10T12:00:00.000Z');

    enviada.marcarComoFalha('webhook 500');
    const falhou = await repo.atualizarResultado(enviada);
    expect(falhou).toMatchObject({ status: StatusNotificacao.FALHOU, erro: 'webhook 500', enviadaEm: null });
  });

  it('canal WEBHOOK e os tipos novos sao aceitos pelo enum do banco', async () => {
    for (const tipo of [
      TipoNotificacao.ORCAMENTO_APROVADO,
      TipoNotificacao.PAGAMENTO_PENDENTE,
      TipoNotificacao.PAGAMENTO_APROVADO,
      TipoNotificacao.PAGAMENTO_RECUSADO,
      TipoNotificacao.OS_CANCELADA,
    ]) {
      await repo.create(nova({ tipo, canal: CanalNotificacao.WEBHOOK, eventoId: `env-${tipo}` }));
    }
    expect(await prisma.notificacao.count({ where: { canal: 'WEBHOOK' } })).toBe(5);
  });

  it('findAll pagina por data desc e filtra por cliente e por OS', async () => {
    await repo.create(nova({ eventoId: 'a' }));
    await repo.create(nova({ eventoId: 'b', clienteId: 'cli-2', ordemDeServicoId: 'os-2' }));
    await repo.create(nova({ eventoId: 'c' }));

    const todas = await repo.findAll({ page: 1, limit: 2 });
    expect(todas.total).toBe(3);
    expect(todas.data).toHaveLength(2);
    expect(todas.data[0].eventoId).toBe('c');

    expect((await repo.findAll({ page: 1, limit: 10, clienteId: 'cli-2' })).data.map((n) => n.eventoId)).toEqual(['b']);
    expect((await repo.findAll({ page: 1, limit: 10, ordemDeServicoId: 'os-1' })).total).toBe(2);
    expect((await repo.findAll({ page: 2, limit: 2 })).data).toHaveLength(1);
  });
});
