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
