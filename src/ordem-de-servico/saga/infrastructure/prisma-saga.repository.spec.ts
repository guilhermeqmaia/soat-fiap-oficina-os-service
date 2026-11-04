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
    prisma.sagaOS.count.mockResolvedValue(2);
    const desde = new Date();
    expect(await repo.countParadasDesde(desde)).toBe(2);
    expect(prisma.sagaOS.count.mock.calls[0][0].where).toEqual({ status: 'EM_ANDAMENTO', passoDesde: { lte: desde } });
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
