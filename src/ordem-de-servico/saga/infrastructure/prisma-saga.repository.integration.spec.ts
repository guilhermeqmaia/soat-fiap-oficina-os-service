import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../prisma/prisma.service';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { startTestDatabase, stopTestDatabase } from '../../../test/database.container';
import { PassoSaga, SagaOS, StatusSaga } from '../domain/saga-os.entity';
import { PrismaSagaRepository } from './prisma-saga.repository';

jest.setTimeout(60000);

describe('PrismaSagaRepository (integration)', () => {
  let prisma: PrismaService;
  let repo: PrismaSagaRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = await startTestDatabase();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService, PrismaSagaRepository],
    }).compile();
    prisma = module.get(PrismaService);
    repo = module.get(PrismaSagaRepository);
    await prisma.onModuleInit();
    await prisma.sagaOS.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await stopTestDatabase();
  });

  const ev = (type: string, numero: string, data: Record<string, unknown> = {}) => ({ type, id: `env-${type}`, data: { numeroOS: numero, ...data } });
const ITENS = [{ tipo: 'SERVICO', referenciaId: 's', nome: 'n', quantidade: 1, precoUnitario: '1.00' }];

  it('save grava a saga; reload preserva historico/compensacoes', async () => {
    const saga = SagaOS.iniciar({ numero: 'OS-S1', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' });
    const salva = await repo.save(saga);
    expect(salva.id).toBeDefined(); expect(salva.version).toBe(0);

    salva.aplicar(ev('execucao.enfileirada', 'OS-S1'));
    salva.aplicar(ev('execucao.diagnostico-concluido', 'OS-S1', { itens: ITENS }));
    const v2 = await repo.save(salva);
    expect(v2.version).toBe(1); // create (0) + um update
    const lida = (await repo.findByNumero('OS-S1'))!;
    expect(lida.passo).toBe(PassoSaga.GERAR_ORCAMENTO);
    expect(lida.historico.map((h) => h.resultado)).toEqual(['avancou', 'avancou', 'avancou']);
  });

  it('lock otimista: segunda gravacao sobre a mesma versao falha', async () => {
    await repo.save(SagaOS.iniciar({ numero: 'OS-S2', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' }));
    const a = (await repo.findByNumero('OS-S2'))!;
    const b = (await repo.findByNumero('OS-S2'))!;
    a.aplicar(ev('execucao.enfileirada', 'OS-S2'));
    await repo.save(a);
    b.aplicar(ev('execucao.recusada', 'OS-S2', { motivo: 'x' }));
    await expect(repo.save(b)).rejects.toThrow(ConcurrentModificationError);
    expect((await repo.findByNumero('OS-S2'))!.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
  });

  it('findComPrazoVencido e countPorStatus', async () => {
    const s = SagaOS.iniciar({ numero: 'OS-S3', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' });
    s.aplicar(ev('execucao.enfileirada', 'OS-S3'));
    s.aplicar(ev('execucao.diagnostico-concluido', 'OS-S3', { itens: ITENS }));
    const t0 = new Date();
    s.aplicar(ev('billing.orcamento-gerado', 'OS-S3', { total: '1.00' }), t0, { aprovacaoMs: 1000, pagamentoMs: 1000 });
    await repo.save(s);
    expect((await repo.findComPrazoVencido(new Date(t0.getTime() + 500))).map((x) => x.numero)).not.toContain('OS-S3');
    expect((await repo.findComPrazoVencido(new Date(t0.getTime() + 1500))).map((x) => x.numero)).toContain('OS-S3');
    const porStatus = await repo.countPorStatus();
    expect(porStatus[StatusSaga.EM_ANDAMENTO]).toBeGreaterThanOrEqual(2);
    // paradas: entrou no passo antes de `desde`
    expect(await repo.countParadasDesde(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(1);
    expect(await repo.countParadasDesde(new Date(Date.now() - 3_600_000))).toBe(0);
  });

  /** Saga que entrou no passo/estado `minAtras` minutos atras. */
  const sagaAte = (numero: string, eventos: Array<[string, Record<string, unknown>?]>, minAtras: number) => {
    const quando = new Date(Date.now() - minAtras * 60_000);
    const s = SagaOS.iniciar({ numero, clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' }, quando);
    for (const [type, data] of eventos) s.aplicar(ev(type, numero, data), quando, { aprovacaoMs: 3_600_000, pagamentoMs: 3_600_000 });
    s.consumirComandos();
    return s;
  };
  const ATE_APROVACAO: Array<[string, Record<string, unknown>?]> = [
    ['execucao.enfileirada'], ['execucao.diagnostico-concluido', { itens: ITENS }], ['billing.orcamento-gerado', { total: '1.00' }],
  ];

  it('compensacao com Billing fora: COMPENSANDO conta na hora mesmo com confirmacao/ignorado depois do chamada-falhou; sai ao reprocessar', async () => {
    const limite = new Date(Date.now() - 3_600_000);
    const base = await repo.countParadasDesde(limite);
    const s = sagaAte('OS-S6', ATE_APROVACAO, 0);
    s.aplicar({ type: 'os.cancelamento-manual', data: { numeroOS: 'OS-S6' } });
    const [cancelar] = s.consumirComandos();
    expect(s.registrarChamadaFalhou(cancelar, { erro: 'HTTP 503', status: 503, tentativas: 3 })).toBe(true);
    s.aplicar(ev('execucao.reservas-liberadas', 'OS-S6')); // confirmacao: vira a ultima entrada
    s.aplicar(ev('billing.orcamento-aprovado', 'OS-S6')); // callback duplicado: ignorado
    let salva = await repo.save(s);
    expect(salva.historico.slice(-3).map((h) => h.resultado)).toEqual(['chamada-falhou', 'confirmacao', 'ignorado']);
    expect(salva.falhasPendentes.map((f) => f.comando)).toEqual(['billing.cancelar-orcamento']);
    expect(await repo.countParadasDesde(limite)).toBe(base + 1);

    salva.reprocessar({});
    salva = await repo.save(salva);
    expect(salva.falhasPendentes).toEqual([]);
    expect(await repo.countParadasDesde(limite)).toBe(base); // COMPENSANDO ha < 1h e sem falha pendente
  });

  it('por tempo: passo automatico e COMPENSANDO contam; espera por cliente/mecanico vai para aguardando pessoa', async () => {
    const limite = new Date(Date.now() - 30 * 60_000);
    const [baseParadas, basePessoa] = [await repo.countParadasDesde(limite), await repo.countAguardandoPessoaDesde(limite)];
    await repo.save(sagaAte('OS-T1', [['execucao.enfileirada'], ['execucao.diagnostico-concluido', { itens: ITENS }]], 120)); // GERAR_ORCAMENTO (automatico)
    await repo.save(sagaAte('OS-T2', ATE_APROVACAO, 120)); // AGUARDAR_APROVACAO (cliente)
    await repo.save(sagaAte('OS-T3', [['execucao.enfileirada']], 120)); // AGUARDAR_DIAGNOSTICO (mecanico)
    const compensando = sagaAte('OS-T4', ATE_APROVACAO, 120);
    compensando.aplicar({ type: 'os.cancelamento-manual', data: { numeroOS: 'OS-T4' } }, new Date(Date.now() - 90 * 60_000));
    await repo.save(compensando); // COMPENSANDO desde 90 min, sem confirmacao
    await repo.save(sagaAte('OS-T5', ATE_APROVACAO, 5)); // cliente, mas recente

    expect(await repo.countParadasDesde(limite)).toBe(baseParadas + 2); // OS-T1 + OS-T4
    const pessoa = await repo.countAguardandoPessoaDesde(limite);
    expect(pessoa[PassoSaga.AGUARDAR_APROVACAO] ?? 0).toBe((basePessoa[PassoSaga.AGUARDAR_APROVACAO] ?? 0) + 1); // OS-T2 (OS-T5 e recente)
    expect(pessoa[PassoSaga.AGUARDAR_DIAGNOSTICO] ?? 0).toBe((basePessoa[PassoSaga.AGUARDAR_DIAGNOSTICO] ?? 0) + 1); // OS-T3
  });

  it('migracao 20261115000000: backfill marca como pendente a saga aberta cuja ultima entrada e chamada-falhou', async () => {
    const s = SagaOS.iniciar({ numero: 'OS-S7', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' });
    s.registrarChamadaFalhou('execucao.enfileirar', { erro: 'HTTP 503', status: 503, tentativas: 3 });
    await repo.save(s);
    await prisma.$executeRawUnsafe(`UPDATE saga_os SET falhas_pendentes = '[]'::jsonb WHERE numero = 'OS-S7'`); // estado anterior a coluna
    const sql = readFileSync(join(__dirname, '../../../../prisma/migrations/20261115000000_saga_falhas_pendentes/migration.sql'), 'utf8');
    await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('UPDATE')));
    const lida = (await repo.findByNumero('OS-S7'))!;
    expect(lida.falhasPendentes).toEqual([
      expect.objectContaining({ comando: 'execucao.enfileirar', passo: PassoSaga.ENFILEIRAR_EXECUCAO, status: StatusSaga.EM_ANDAMENTO, tentativas: 3 }),
    ]);
    expect(lida.aguardandoReprocessamento).toBe(true);
  });

  it('countParadasDesde conta na hora a saga com chamada-falhou pendente e a tira ao reprocessar (US-F4-18)', async () => {
    const antigo = new Date(Date.now() - 3_600_000);
    const base = await repo.countParadasDesde(antigo);
    const s = SagaOS.iniciar({ numero: 'OS-S5', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' });
    s.registrarChamadaFalhou('execucao.enfileirar', { erro: 'HTTP 503', status: 503, tentativas: 3 });
    let salva = await repo.save(s);
    expect(salva.historico[salva.historico.length - 1]).toMatchObject({ resultado: 'chamada-falhou', tentativas: 3, evento: 'execucao.enfileirar' });
    expect(await repo.countParadasDesde(antigo)).toBe(base + 1);
    salva.reprocessar({});
    salva = await repo.save(salva);
    expect(await repo.countParadasDesde(antigo)).toBe(base);
  });

  it('save dentro de um $transaction externo faz rollback junto', async () => {
    const saga = SagaOS.iniciar({ numero: 'OS-S4', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' });
    await expect(
      prisma.$transaction(async (tx) => {
        await repo.save(saga, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await repo.findByNumero('OS-S4')).toBeNull();
  });
});
