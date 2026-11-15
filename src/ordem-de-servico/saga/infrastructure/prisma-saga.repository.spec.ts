import { PrismaSagaRepository } from './prisma-saga.repository';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { SagaOS, StatusSaga } from '../domain/saga-os.entity';

const row = (extra: Partial<Record<string, unknown>> = {}) => ({
  id: 'saga-1', numero: 'OS-1', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd', passo: 'ENFILEIRAR_EXECUCAO', status: 'EM_ANDAMENTO',
  passoDesde: new Date(), historico: [], compensacoes: [], prazoAprovacao: null, prazoPagamento: null, version: 2, createdAt: new Date(), updatedAt: new Date(), ...extra,
});
const tx = { sagaOS: { create: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn(), deleteMany: jest.fn() } };
const prisma = {
  sagaOS: { findUnique: jest.fn(), findMany: jest.fn(), groupBy: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  $queryRaw: jest.fn(),
} as any;

describe('PrismaSagaRepository (unit)', () => {
  const repo = new PrismaSagaRepository(prisma);
  beforeEach(() => jest.clearAllMocks());

  it('findByNumero mapeia a linha para a entidade (null quando ausente)', async () => {
    prisma.sagaOS.findUnique.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    const s = await repo.findByNumero('OS-1');
    expect(s).toBeInstanceOf(SagaOS); expect(s?.version).toBe(2); expect(s?.status).toBe(StatusSaga.EM_ANDAMENTO);
    expect(await repo.findByNumero('OS-2')).toBeNull();
  });

  it('save de saga nova: create; os comandos pendentes NAO sao persistidos (saem por HTTP depois do commit)', async () => {
    tx.sagaOS.create.mockResolvedValue({ id: 'saga-1' }); tx.sagaOS.findUniqueOrThrow.mockResolvedValue(row());
    const saga = SagaOS.iniciar({ numero: 'OS-1', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' });
    await repo.save(saga);
    expect(tx.sagaOS.create.mock.calls[0][0].data).toMatchObject({ numero: 'OS-1', passo: 'ENFILEIRAR_EXECUCAO', status: 'EM_ANDAMENTO' });
    expect(saga.comandosPendentes).toHaveLength(1);
  });

  it('save de saga existente usa lock otimista e falha em conflito', async () => {
    tx.sagaOS.updateMany.mockResolvedValueOnce({ count: 1 }); tx.sagaOS.findUniqueOrThrow.mockResolvedValue(row({ version: 3 }));
    const saga = SagaOS.reconstitute({ ...(row() as any), historico: [], compensacoes: [] });
    expect((await repo.save(saga)).version).toBe(3);
    expect(tx.sagaOS.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'saga-1', version: 2 }, data: { version: { increment: 1 } } });
    tx.sagaOS.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.save(saga)).rejects.toThrow(ConcurrentModificationError);
  });

  it('save com tx externo nao abre transacao propria; unique(numero) vira ConcurrentModificationError', async () => {
    tx.sagaOS.create.mockResolvedValue({ id: 'saga-9' }); tx.sagaOS.findUniqueOrThrow.mockResolvedValue(row({ id: 'saga-9' }));
    await repo.save(SagaOS.iniciar({ numero: 'OS-9', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' }), tx);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    tx.sagaOS.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(repo.save(SagaOS.iniciar({ numero: 'OS-9', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' }), tx)).rejects.toThrow(ConcurrentModificationError);
  });

  it('deleteByNumero e countParadasDesde delegam ao Prisma', async () => {
    await repo.deleteByNumero('OS-1');
    expect(prisma.sagaOS.deleteMany).toHaveBeenCalledWith({ where: { numero: 'OS-1' } });
    prisma.$queryRaw.mockResolvedValueOnce([{ total: 2 }]);
    const desde = new Date();
    expect(await repo.countParadasDesde(desde)).toBe(2);
    const [sql, ...valores] = prisma.$queryRaw.mock.calls[0];
    const texto = sql.join('?');
    expect(texto).toContain('jsonb_array_length(falhas_pendentes) > 0');
    expect(texto).not.toContain("historico -> -1");
    expect(valores[0]).toBe('EM_ANDAMENTO');
    expect(valores[1].values).toEqual(['ENFILEIRAR_EXECUCAO', 'GERAR_ORCAMENTO', 'INICIAR_EXECUCAO', 'COBRAR']); // so passos automaticos
    expect(valores.slice(2)).toEqual([desde, 'COMPENSANDO', desde, 'EM_ANDAMENTO', 'COMPENSANDO']);
    prisma.$queryRaw.mockResolvedValueOnce([]);
    expect(await repo.countParadasDesde(desde)).toBe(0);
  });

  it('countAguardandoPessoaDesde agrupa por passo so os passos que esperam cliente/mecanico', async () => {
    prisma.sagaOS.groupBy.mockResolvedValueOnce([{ passo: 'AGUARDAR_APROVACAO', _count: { _all: 3 } }]);
    const desde = new Date();
    expect(await repo.countAguardandoPessoaDesde(desde)).toEqual({ AGUARDAR_APROVACAO: 3 });
    expect(prisma.sagaOS.groupBy.mock.calls[0][0]).toEqual({
      by: ['passo'],
      where: { status: 'EM_ANDAMENTO', passo: { in: ['AGUARDAR_DIAGNOSTICO', 'AGUARDAR_APROVACAO', 'AGUARDAR_FINALIZACAO', 'AGUARDAR_PAGAMENTO'] }, passoDesde: { lte: desde } },
      _count: { _all: true },
    });
  });

  it('save grava as falhas pendentes; findByNumero as le (linha antiga sem a coluna = nenhuma)', async () => {
    const falha = { comando: 'execucao.enfileirar', passo: 'ENFILEIRAR_EXECUCAO', status: 'EM_ANDAMENTO', em: 'x', tentativas: 3, detalhe: 'd' };
    prisma.sagaOS.findUnique.mockResolvedValueOnce(row({ falhasPendentes: [falha] })).mockResolvedValueOnce(row({ falhasPendentes: null }));
    const s = (await repo.findByNumero('OS-1'))!;
    expect(s.falhasPendentes).toEqual([falha]);
    expect((await repo.findByNumero('OS-1'))!.falhasPendentes).toEqual([]);
    tx.sagaOS.updateMany.mockResolvedValueOnce({ count: 1 }); tx.sagaOS.findUniqueOrThrow.mockResolvedValue(row());
    await repo.save(s);
    expect(tx.sagaOS.updateMany.mock.calls[0][0].data.falhasPendentes).toEqual([falha]);
  });

  it('findComPrazoVencido e countPorStatus delegam ao Prisma', async () => {
    prisma.sagaOS.findMany.mockResolvedValue([row()]);
    const agora = new Date();
    expect(await repo.findComPrazoVencido(agora, 10)).toHaveLength(1);
    expect(prisma.sagaOS.findMany.mock.calls[0][0].where).toEqual({ status: 'EM_ANDAMENTO', OR: [{ prazoAprovacao: { lte: agora } }, { prazoPagamento: { lte: agora } }] });
    prisma.sagaOS.groupBy.mockResolvedValue([{ status: 'EM_ANDAMENTO', _count: { _all: 2 } }, { status: 'CANCELADA', _count: { _all: 1 } }]);
    expect(await repo.countPorStatus()).toEqual({ EM_ANDAMENTO: 2, CANCELADA: 1 });
  });
});
