import { FakeDomainEventPublisher } from '@guilhermeqmaia/oficina-kit/testing';
import { OrdemDeServico } from '../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../domain/value-objects/status-os.vo';
import { MotivoCancelamento } from '../../domain/value-objects/motivo-cancelamento';
import { ItemServicoOS } from '../../domain/value-objects/item-servico-os.vo';
import { ItemProdutoOS } from '../../domain/value-objects/item-produto-os.vo';
import { ClienteNotFoundError } from '../../domain/errors/cliente-not-found.error';
import { VeiculoNotFoundError } from '../../domain/errors/veiculo-not-found.error';
import { VeiculoClienteMismatchError } from '../../domain/errors/veiculo-cliente-mismatch.error';
import { OrdemDeServicoNotFoundError } from '../../domain/errors/ordem-de-servico-not-found.error';
import { CriarOrdemDeServicoUseCase } from './criar-ordem-de-servico.use-case';
import { CancelarOrdemDeServicoUseCase } from './cancelar-ordem-de-servico.use-case';
import { EntregarOrdemDeServicoUseCase } from './entregar-ordem-de-servico.use-case';
import { DeletarOrdemDeServicoUseCase } from './deletar-ordem-de-servico.use-case';
import { BuscarStatusPorNumeroUseCase } from './buscar-status-por-numero.use-case';
import { BuscarDetalhesOrdemDeServicoUseCase } from './buscar-detalhes-ordem-de-servico.use-case';

const osComItens = (status = StatusOS.AGUARDANDO_APROVACAO) => {
  const base = OrdemDeServico.create({ clienteId: 'cli-1', veiculoId: 'vei-1', descricaoInicial: 'Barulho ao frenar' });
  base.iniciarDiagnostico();
  base.registrarDiagnostico({ diagnostico: 'Pastilhas gastas', mecanicoId: 'mec-1', itens: [new ItemServicoOS('s1', 'Troca de pastilha', 1, 200, [new ItemProdutoOS('p1', 'Pastilha', 2, 50)])] });
  if (status !== StatusOS.EM_DIAGNOSTICO) base.aguardarAprovacao();
  if (status === StatusOS.FINALIZADA) { base.iniciarExecucao(); base.aguardarPagamento(); base.finalizar(); }
  return OrdemDeServico.reconstitute({
    id: 'os-1', numero: base.numero, clienteId: 'cli-1', veiculoId: 'vei-1', mecanicoId: 'mec-1', descricaoInicial: base.descricaoInicial, diagnostico: base.diagnostico,
    status: base.status, motivoCancelamento: null, createdAt: new Date('2026-10-01T10:00:00Z'), updatedAt: new Date('2026-10-02T10:00:00Z'), itensServico: [...base.itensServico],
  });
};
const orquestrador = {
  iniciar: jest.fn(async () => ({ saga: { numero: 'OS-1' }, comandos: [{ type: 'execucao.enfileirar', data: {} }] })),
  executarComandos: jest.fn().mockResolvedValue(undefined),
  processar: jest.fn().mockResolvedValue(undefined),
} as any;
const uow = { executar: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn('tx-1')) } as any;
const sagas = { deleteByNumero: jest.fn().mockResolvedValue(undefined) } as any;
const gatewayCom = (os: OrdemDeServico | null) => ({
  findById: jest.fn(async () => os), findByNumero: jest.fn(async () => os),
  create: jest.fn(async (o: OrdemDeServico) => o), update: jest.fn(async (o: OrdemDeServico) => o), delete: jest.fn(async () => undefined),
}) as any;
const cliente = { id: 'cli-1', nome: 'Joao', cpfCnpj: { value: '52998224725' }, email: 'j@x.com', telefone: '11999990000' };
const veiculo = { id: 'vei-1', clienteId: 'cli-1', placa: { value: 'ABC1D23' }, marca: 'Toyota', modelo: 'Corolla', ano: 2024 };

describe('CriarOrdemDeServicoUseCase', () => {
  const clienteGw = { findById: jest.fn(async (id: string) => (id === 'cli-1' ? cliente : null)), findByCpfCnpj: jest.fn() } as any;
  const veiculoGw = { findById: jest.fn(async (id: string) => (id === 'vei-1' ? veiculo : id === 'vei-outro' ? { ...veiculo, id: 'vei-outro', clienteId: 'cli-2' } : null)) } as any;

  it('abre a OS RECEBIDA sem itens', async () => {
    const g = gatewayCom(null);
    const os = await new CriarOrdemDeServicoUseCase(g, clienteGw, veiculoGw, orquestrador, uow).execute({ clienteId: 'cli-1', veiculoId: 'vei-1', descricaoInicial: 'Barulho ao frenar' });
    expect(os.status).toBe(StatusOS.RECEBIDA); expect(os.itensServico).toHaveLength(0); expect(g.create).toHaveBeenCalled();
    // OS e saga na mesma transacao: o mesmo tx vai para o gateway e para o orquestrador
    expect(g.create).toHaveBeenCalledWith(expect.anything(), 'tx-1');
    expect(orquestrador.iniciar).toHaveBeenCalledWith(expect.objectContaining({ numero: os.numero }), { descricaoProblema: 'Barulho ao frenar', falhaSimulada: null }, 'tx-1');
    // o comando execucao.enfileirar sai DEPOIS do commit, com a saga devolvida por iniciar
    expect(orquestrador.executarComandos).toHaveBeenCalledWith({ numero: 'OS-1' }, [{ type: 'execucao.enfileirar', data: {} }]);
    // a OS devolvida e relida apos a resposta sincrona da Execucao (pode ja estar EM_DIAGNOSTICO)
    expect(g.findByNumero).toHaveBeenCalledWith(os.numero);
  });
  it('devolve a OS criada quando a releitura nao encontra (gateway em memoria)', async () => {
    const g = gatewayCom(null);
    g.findByNumero.mockResolvedValueOnce(null);
    const os = await new CriarOrdemDeServicoUseCase(g, clienteGw, veiculoGw, orquestrador, uow).execute({ clienteId: 'cli-1', veiculoId: 'vei-1', descricaoInicial: 'Barulho ao frenar' });
    expect(os.status).toBe(StatusOS.RECEBIDA);
  });
  it('valida cliente, veiculo e posse do veiculo', async () => {
    const uc = new CriarOrdemDeServicoUseCase(gatewayCom(null), clienteGw, veiculoGw, orquestrador, uow);
    await expect(uc.execute({ clienteId: 'cli-x', veiculoId: 'vei-1', descricaoInicial: 'Barulho ao frenar' })).rejects.toThrow(ClienteNotFoundError);
    await expect(uc.execute({ clienteId: 'cli-1', veiculoId: 'vei-x', descricaoInicial: 'Barulho ao frenar' })).rejects.toThrow(VeiculoNotFoundError);
    await expect(uc.execute({ clienteId: 'cli-1', veiculoId: 'vei-outro', descricaoInicial: 'Barulho ao frenar' })).rejects.toThrow(VeiculoClienteMismatchError);
  });
});

describe('Cancelar / Entregar / Deletar', () => {
  it('cancelar (atendente) delega a saga com motivo OPERADOR por default', async () => {
    const g = gatewayCom(osComItens());
    await new CancelarOrdemDeServicoUseCase(g, orquestrador).execute({ id: 'os-1' });
    expect(orquestrador.processar).toHaveBeenCalledWith({ type: 'os.cancelamento-manual', data: { numeroOS: expect.any(String), motivo: MotivoCancelamento.OPERADOR } });
  });
  it('cancelar aceita motivo explicito, rejeita OS nao cancelavel antes da saga e falha para OS inexistente', async () => {
    orquestrador.processar.mockClear();
    await new CancelarOrdemDeServicoUseCase(gatewayCom(osComItens()), orquestrador).execute({ id: 'os-1', motivo: MotivoCancelamento.TIMEOUT_APROVACAO });
    expect(orquestrador.processar.mock.calls[0][0].data.motivo).toBe(MotivoCancelamento.TIMEOUT_APROVACAO);
    orquestrador.processar.mockClear();
    await expect(new CancelarOrdemDeServicoUseCase(gatewayCom(osComItens(StatusOS.FINALIZADA)), orquestrador).execute({ id: 'os-1' })).rejects.toThrow();
    expect(orquestrador.processar).not.toHaveBeenCalled();
    await expect(new CancelarOrdemDeServicoUseCase(gatewayCom(null), orquestrador).execute({ id: 'x' })).rejects.toThrow(OrdemDeServicoNotFoundError);
  });
  it('entregar exige FINALIZADA', async () => {
    const events = new FakeDomainEventPublisher();
    const ok = await new EntregarOrdemDeServicoUseCase(gatewayCom(osComItens(StatusOS.FINALIZADA)), events).execute({ id: 'os-1' });
    expect(ok.status).toBe(StatusOS.ENTREGUE);
    await expect(new EntregarOrdemDeServicoUseCase(gatewayCom(osComItens()), events).execute({ id: 'os-1' })).rejects.toThrow();
  });
  it('deletar remove a OS existente', async () => {
    const g = gatewayCom(osComItens());
    await new DeletarOrdemDeServicoUseCase(g, sagas).execute({ id: 'os-1' });
    expect(g.delete).toHaveBeenCalledWith('os-1');
    expect(sagas.deleteByNumero).toHaveBeenCalledWith(expect.any(String));
    await expect(new DeletarOrdemDeServicoUseCase(gatewayCom(null), sagas).execute({ id: 'x' })).rejects.toThrow(OrdemDeServicoNotFoundError);
  });
});

describe('consultas por snapshot (sem gateways de catalogo)', () => {
  it('status publico por numero devolve nomes e totais do snapshot', async () => {
    const view = await new BuscarStatusPorNumeroUseCase(gatewayCom(osComItens())).execute({ numero: 'OS-1' });
    expect(view.servicos[0]).toMatchObject({ nome: 'Troca de pastilha', subtotal: 200, produtos: [{ nome: 'Pastilha', subtotal: 100 }] });
    expect(view.valorTotal).toBe(300); expect(view.motivoCancelamento).toBeNull();
    await expect(new BuscarStatusPorNumeroUseCase(gatewayCom(null)).execute({ numero: 'x' })).rejects.toThrow(OrdemDeServicoNotFoundError);
  });
  it('detalhes trazem cliente, veiculo, mecanico e itens com nome', async () => {
    const clienteGw = { findById: jest.fn(async () => cliente) } as any; const veiculoGw = { findById: jest.fn(async () => veiculo) } as any;
    const usuarioGw = { findById: jest.fn(async () => ({ nome: 'Carlos Mecanico' })) } as any;
    const v = await new BuscarDetalhesOrdemDeServicoUseCase(gatewayCom(osComItens()), clienteGw, veiculoGw, usuarioGw).execute({ id: 'os-1' });
    expect(v.cabecalho.mecanicoAtribuido).toBe('Carlos Mecanico'); expect(v.cabecalho.dadosCliente.cpfCnpj).toBe('52998224725');
    expect(v.corpo.servicos[0].descricaoServico).toBe('Troca de pastilha'); expect(v.rodape.valorTotalOrdemServico).toBe(300);
    expect(v.cabecalho.dataHoraAbertura).toMatch(/^\d{2}\/\d{2}\/2026 - \d{2}:\d{2}$/);
  });
  it('detalhes toleram cliente/veiculo/mecanico ausentes', async () => {
    const nulo = { findById: jest.fn(async () => null) } as any;
    const v = await new BuscarDetalhesOrdemDeServicoUseCase(gatewayCom(osComItens()), nulo, nulo, nulo).execute({ id: 'os-1' });
    expect(v.cabecalho.dadosCliente.nome).toBe('Cliente removido'); expect(v.cabecalho.mecanicoAtribuido).toBeNull();
  });
});
