import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaOrdemDeServicoRepository } from './prisma-ordem-de-servico.repository';
import { OrdemDeServico } from '../domain/ordem-de-servico.entity';
import { StatusOS } from '../domain/value-objects/status-os.vo';
import { MotivoCancelamento } from '../domain/value-objects/motivo-cancelamento';
import { ItemServicoOS } from '../domain/value-objects/item-servico-os.vo';
import { ItemProdutoOS } from '../domain/value-objects/item-produto-os.vo';
import { startTestDatabase, stopTestDatabase } from '../../test/database.container';
import { ConcurrentModificationError } from '../domain/errors/concurrent-modification.error';

jest.setTimeout(60000);

describe('PrismaOrdemDeServicoRepository (integration)', () => {
  let repository: PrismaOrdemDeServicoRepository;
  let prisma: PrismaService;
  let clienteId: string;
  let veiculoId: string;
  let mecanicoId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = await startTestDatabase();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService, PrismaOrdemDeServicoRepository],
    }).compile();
    prisma = module.get(PrismaService);
    repository = module.get(PrismaOrdemDeServicoRepository);
    await prisma.onModuleInit();

    await prisma.ordemDeServico.deleteMany();
    await prisma.veiculo.deleteMany();
    await prisma.cliente.deleteMany();
    await prisma.usuario.deleteMany();
    mecanicoId = (await prisma.usuario.create({ data: { nome: 'Mecanico', email: 'mec.os.repo@oficina.com', senhaHash: 'x', role: 'MECANICO', ativo: true } })).id;
    clienteId = (await prisma.cliente.create({ data: { nome: 'Cliente', cpfCnpj: '52998224725', telefone: '11999990000', email: 'cliente@test.com' } })).id;
    veiculoId = (await prisma.veiculo.create({ data: { placa: 'ABC1D23', marca: 'Toyota', modelo: 'Corolla', ano: 2024, clienteId, ativo: true } })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await stopTestDatabase();
  });

  const nova = () => OrdemDeServico.create({ clienteId, veiculoId, descricaoInicial: 'Barulho ao frenar' });

  it('create + findById/findByNumero/existsByNumero', async () => {
    const os = await repository.create(nova());
    expect(os.id).toBeDefined();
    expect((await repository.findById(os.id as string))?.status).toBe(StatusOS.RECEBIDA);
    expect((await repository.findByNumero(os.numero))?.id).toBe(os.id);
    expect(await repository.existsByNumero(os.numero)).toBe(true);
    expect(await repository.existsByNumero('OS-0000')).toBe(false);
    expect(await repository.findById('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('update persiste o snapshot do diagnostico (sem FK para catalogo) e troca de status', async () => {
    const os = await repository.create(nova());
    os.iniciarDiagnostico();
    os.registrarDiagnostico({
      diagnostico: 'Pastilhas gastas', mecanicoId,
      itens: [new ItemServicoOS('srv-inexistente-no-os-service', 'Troca de pastilha', 1, 200, [new ItemProdutoOS('prd-qualquer', 'Pastilha', 2, 50)])],
    });
    os.aguardarAprovacao();
    const saved = await repository.update(os);
    expect(saved.status).toBe(StatusOS.AGUARDANDO_APROVACAO);
    expect(saved.mecanicoId).toBe(mecanicoId);
    expect(saved.itensServico[0]).toMatchObject({ nome: 'Troca de pastilha', precoUnitario: 200 });
    expect(saved.itensServico[0].produtos[0]).toMatchObject({ nome: 'Pastilha', quantidade: 2 });
    expect(saved.valorTotal()).toBe(300);

    // reaplicar o diagnostico substitui o snapshot (nao duplica)
    const again = await repository.findById(os.id as string);
    again!.iniciarExecucao();
    again!.aguardarPagamento(); // cobranca depois da execucao (ADR-0012)
    const saved2 = await repository.update(again!);
    expect(saved2.status).toBe(StatusOS.AGUARDANDO_PAGAMENTO);
    expect(await prisma.itemOrdemDeServicoServico.count({ where: { ordemDeServicoId: os.id } })).toBe(1);
    expect(await prisma.itemOrdemDeServicoProduto.count()).toBeGreaterThanOrEqual(1);
  });

  it('update persiste motivo de cancelamento', async () => {
    const os = await repository.create(nova());
    os.cancelar(MotivoCancelamento.TIMEOUT_APROVACAO);
    const saved = await repository.update(os);
    expect(saved.status).toBe(StatusOS.CANCELADA);
    expect(saved.motivoCancelamento).toBe(MotivoCancelamento.TIMEOUT_APROVACAO);
  });

  it('findAll pagina, filtra e esconde encerradas por padrao', async () => {
    const all = await repository.findAll({ page: 1, limit: 100, incluirEncerradas: true });
    const ativas = await repository.findAll({ page: 1, limit: 100 });
    expect(all.total).toBeGreaterThan(ativas.total);
    expect(ativas.data.every((o) => ![StatusOS.CANCELADA, StatusOS.FINALIZADA, StatusOS.ENTREGUE].includes(o.status))).toBe(true);
    expect(ativas.data[0].status).toBe(StatusOS.AGUARDANDO_PAGAMENTO);
    const porStatus = await repository.findAll({ status: StatusOS.CANCELADA, incluirEncerradas: true });
    expect(porStatus.data.every((o) => o.status === StatusOS.CANCELADA)).toBe(true);
    const porCliente = await repository.findAll({ clienteId, incluirEncerradas: true });
    expect(porCliente.total).toBe(all.total);
    expect((await repository.findAll({ page: 1, limit: 1, incluirEncerradas: true })).data).toHaveLength(1);
  });

  it('delete remove a OS e os itens em cascata', async () => {
    const os = await repository.create(nova());
    os.iniciarDiagnostico();
    os.registrarDiagnostico({ diagnostico: 'Pastilhas gastas', mecanicoId, itens: [new ItemServicoOS('s', 'Alinhamento', 1, 80)] });
    await repository.update(os);
    await repository.delete(os.id as string);
    expect(await repository.findById(os.id as string)).toBeNull();
    expect(await prisma.itemOrdemDeServicoServico.count({ where: { ordemDeServicoId: os.id } })).toBe(0);
  });

  it('lock otimista: a segunda gravacao sobre a mesma versao falha e nao sobrescreve', async () => {
    const criada = await repository.create(nova());
    const a = (await repository.findById(criada.id as string))!;
    const b = (await repository.findById(criada.id as string))!;
    expect(a.version).toBe(0);
    a.cancelar(MotivoCancelamento.OPERADOR);
    const salva = await repository.update(a);
    expect(salva.version).toBe(1);
    b.iniciarDiagnostico();
    await expect(repository.update(b)).rejects.toThrow(ConcurrentModificationError);
    expect((await repository.findById(criada.id as string))?.status).toBe(StatusOS.CANCELADA);
  });
});
