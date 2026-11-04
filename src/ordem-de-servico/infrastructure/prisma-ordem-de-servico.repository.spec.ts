import { Test, TestingModule } from '@nestjs/testing';
import { PrismaOrdemDeServicoRepository } from './prisma-ordem-de-servico.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { StatusOS } from '../domain/value-objects/status-os.vo';
import { OrdemDeServico } from '../domain/ordem-de-servico.entity';
import { ItemServicoOS } from '../domain/value-objects/item-servico-os.vo';
import { ItemProdutoOS } from '../domain/value-objects/item-produto-os.vo';
import { MotivoCancelamento } from '../domain/value-objects/motivo-cancelamento';
import { OUTBOX_REPOSITORY } from '@guilhermeqmaia/oficina-kit/messaging';
import { ConcurrentModificationError } from '../domain/errors/concurrent-modification.error';

const dbRecord = {
  id: 'os-123', numero: 'OS-2026-00001', clienteId: 'cliente-123', veiculoId: 'veiculo-456', usuarioId: null,
  descricaoInicial: 'Cliente relata problemas no freio', diagnostico: null, status: StatusOS.RECEBIDA, motivoCancelamento: null,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), itensServico: [] as any[],
};
const dbRecordWithItens = {
  ...dbRecord, usuarioId: 'mec-1', status: StatusOS.AGUARDANDO_APROVACAO,
  itensServico: [{ servicoId: 'serv-abc', nome: 'Troca', quantidade: 2, precoUnitario: '150.00', produtos: [{ produtoId: 'p1', nome: 'Pastilha', quantidade: 1, precoUnitario: '80.00' }] }],
};
const tx = {
  ordemDeServico: { create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn() },
  itemOrdemDeServicoServico: { deleteMany: jest.fn(), create: jest.fn() },
};
const outbox = { gravar: jest.fn(), pendentes: jest.fn(), marcarEnviada: jest.fn(), marcarFalha: jest.fn() };
const mockPrisma = {
  ordemDeServico: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), delete: jest.fn() },
  $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};

describe('PrismaOrdemDeServicoRepository (unit)', () => {
  let repository: PrismaOrdemDeServicoRepository;
  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaOrdemDeServicoRepository,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OUTBOX_REPOSITORY, useValue: outbox },
      ],
    }).compile();
    repository = module.get(PrismaOrdemDeServicoRepository);
  });

  it('create persiste cabecalho na transacao e grava os.aberta no outbox com o mesmo tx', async () => {
    tx.ordemDeServico.create.mockResolvedValue(dbRecord);
    const os = OrdemDeServico.create({ clienteId: 'cliente-123', veiculoId: 'veiculo-456', descricaoInicial: 'Cliente relata problemas no freio' });
    os.registrarAbertura({ cliente: { nome: 'Joao', cpfCnpj: '52998224725' }, veiculo: { placa: 'ABC1D23', modelo: 'Corolla' } });
    const result = await repository.create(os);
    expect(result).toBeInstanceOf(OrdemDeServico);
    expect(result.id).toBe('os-123');
    expect(tx.ordemDeServico.create.mock.calls[0][0].data).toMatchObject({ status: 'RECEBIDA', itensServico: { create: [] } });
    expect(outbox.gravar).toHaveBeenCalledTimes(1);
    const [envelope, txUsado] = outbox.gravar.mock.calls[0];
    expect(envelope).toMatchObject({ type: 'os.aberta', producer: 'os-service', correlationId: os.numero, version: 1 });
    expect(envelope.data.cliente.cpfMascarado).toBe('***.***.***-25');
    expect(txUsado).toBe(tx);
    expect(os.eventosIntegracao).toHaveLength(0);
  });

  it('update grava os eventos pendentes (os.cancelada) no outbox dentro da transacao', async () => {
    tx.ordemDeServico.findUnique.mockResolvedValue({ ...dbRecord, status: StatusOS.CANCELADA, motivoCancelamento: 'OPERADOR' });
    const os = OrdemDeServico.reconstitute({
      id: 'os-123', numero: 'OS-2026-00001', clienteId: 'c', veiculoId: 'v', mecanicoId: null, descricaoInicial: 'Cliente relata', diagnostico: null, status: StatusOS.RECEBIDA,
      motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(), itensServico: [],
    });
    os.cancelar(MotivoCancelamento.OPERADOR);
    await repository.update(os);
    expect(outbox.gravar.mock.calls[0][0]).toMatchObject({ type: 'os.cancelada', correlationId: 'OS-2026-00001', data: { numeroOS: 'OS-2026-00001', motivo: 'OPERADOR' } });
    expect(outbox.gravar.mock.calls[0][1]).toBe(tx);
  });

  it('update com versao desatualizada lanca ConcurrentModificationError e nao grava evento (lock otimista)', async () => {
    tx.ordemDeServico.updateMany.mockResolvedValueOnce({ count: 0 });
    const os = OrdemDeServico.reconstitute({
      id: 'os-123', numero: 'OS-2026-00001', clienteId: 'c', veiculoId: 'v', mecanicoId: null, descricaoInicial: 'Cliente relata', diagnostico: null, status: StatusOS.RECEBIDA,
      motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(), itensServico: [], version: 3,
    });
    os.cancelar(MotivoCancelamento.OPERADOR);
    await expect(repository.update(os)).rejects.toThrow(ConcurrentModificationError);
    expect(tx.ordemDeServico.updateMany.mock.calls[0][0].where).toEqual({ id: 'os-123', version: 3 });
    expect(outbox.gravar).not.toHaveBeenCalled();
  });

  it('findById/findByNumero mapeiam snapshot (nome + Decimal -> number) e null quando ausente', async () => {
    mockPrisma.ordemDeServico.findUnique.mockResolvedValueOnce(dbRecordWithItens).mockResolvedValueOnce(null).mockResolvedValueOnce(dbRecordWithItens);
    const os = await repository.findById('os-123');
    expect(os?.itensServico[0]).toMatchObject({ nome: 'Troca', precoUnitario: 150 });
    expect(os?.itensServico[0].produtos[0]).toMatchObject({ nome: 'Pastilha', precoUnitario: 80 });
    expect(os?.mecanicoId).toBe('mec-1');
    expect(await repository.findById('x')).toBeNull();
    expect((await repository.findByNumero('OS-2026-00001'))?.valorTotal()).toBe(380);
  });

  it('findAll exclui encerradas por padrao, ordena por prioridade de status e pagina em memoria', async () => {
    const mk = (id: string, status: StatusOS, d: string) => ({ ...dbRecord, id, numero: id, status, createdAt: new Date(d) });
    mockPrisma.ordemDeServico.findMany.mockResolvedValue([
      mk('a', StatusOS.RECEBIDA, '2026-01-01'), mk('b', StatusOS.EM_EXECUCAO, '2026-01-03'), mk('c', StatusOS.AGUARDANDO_PAGAMENTO, '2026-01-02'), mk('d', StatusOS.EM_EXECUCAO, '2026-01-01'),
    ]);
    mockPrisma.ordemDeServico.count.mockResolvedValue(4);
    const r = await repository.findAll({ page: 1, limit: 3 });
    // AGUARDANDO_PAGAMENTO (pos-execucao) e a mais avancada; EM_EXECUCAO em seguida, mais antigas primeiro
    expect(r.data.map((o) => o.id)).toEqual(['c', 'd', 'b']);
    expect(r.total).toBe(4);
    const where = mockPrisma.ordemDeServico.findMany.mock.calls[0][0].where;
    expect(where.NOT).toEqual([{ status: 'FINALIZADA' }, { status: 'ENTREGUE' }, { status: 'CANCELADA' }]);
  });

  it('findAll aplica filtros e incluirEncerradas', async () => {
    mockPrisma.ordemDeServico.findMany.mockResolvedValue([]); mockPrisma.ordemDeServico.count.mockResolvedValue(0);
    await repository.findAll({ clienteId: 'c', status: StatusOS.CANCELADA, numero: 'os-20', incluirEncerradas: true });
    const where = mockPrisma.ordemDeServico.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ clienteId: 'c', status: 'CANCELADA', numero: { contains: 'os-20', mode: 'insensitive' } });
  });

  it('update substitui o snapshot dentro da transacao', async () => {
    tx.ordemDeServico.findUnique.mockResolvedValue(dbRecordWithItens);
    const os = OrdemDeServico.reconstitute({
      id: 'os-123', numero: 'OS-2026-00001', clienteId: 'c', veiculoId: 'v', mecanicoId: 'mec-1', descricaoInicial: 'Cliente relata', diagnostico: 'd', status: StatusOS.AGUARDANDO_APROVACAO,
      motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(), itensServico: [new ItemServicoOS('serv-abc', 'Troca', 2, 150, [new ItemProdutoOS('p1', 'Pastilha', 1, 80)])],
    });
    const r = await repository.update(os);
    expect(tx.ordemDeServico.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'os-123', version: 0 }, data: { status: 'AGUARDANDO_APROVACAO', usuarioId: 'mec-1', motivoCancelamento: null, version: { increment: 1 } } });
    expect(tx.itemOrdemDeServicoServico.deleteMany).toHaveBeenCalledWith({ where: { ordemDeServicoId: 'os-123' } });
    expect(tx.itemOrdemDeServicoServico.create.mock.calls[0][0].data).toMatchObject({ nome: 'Troca', produtos: { create: [{ nome: 'Pastilha', produtoId: 'p1' }] } });
    expect(r.itensServico).toHaveLength(1);
  });

  it('delete e existsByNumero delegam ao Prisma', async () => {
    mockPrisma.ordemDeServico.delete.mockResolvedValue(dbRecord);
    await repository.delete('os-123');
    expect(mockPrisma.ordemDeServico.delete).toHaveBeenCalledWith({ where: { id: 'os-123' } });
    mockPrisma.ordemDeServico.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await repository.existsByNumero('OS-1')).toBe(true);
    expect(await repository.existsByNumero('OS-2')).toBe(false);
  });
});
