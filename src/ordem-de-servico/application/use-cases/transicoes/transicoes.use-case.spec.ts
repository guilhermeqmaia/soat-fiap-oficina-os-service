import { FakeDomainEventPublisher } from '@guilhermeqmaia/oficina-kit/testing';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { MotivoCancelamento } from '../../../domain/value-objects/motivo-cancelamento';
import { OrdemDeServicoNotFoundError } from '../../../domain/errors/ordem-de-servico-not-found.error';
import { InvalidStatusTransitionError } from '../../../domain/errors/invalid-status-transition.error';
import { OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { OsStatusAlteradoEvent } from '../../../domain/events/os-status-alterado.event';
import { OrcamentoProntoEvent } from '../../../../shared/domain/events/orcamento-pronto.event';
import { OsFinalizadaEvent } from '../../../../shared/domain/events/os-finalizada.event';
import { OsAcaoEvent } from '../../../../shared/domain/events/os-acao.event';
import {
  RegistrarCancelamentoUseCase,
  RegistrarDiagnosticoUseCase,
  RegistrarEnfileiramentoUseCase,
  RegistrarExecucaoFinalizadaUseCase,
  RegistrarExecucaoIniciadaUseCase,
  RegistrarOrcamentoGeradoUseCase,
  RegistrarPagamentoAprovadoUseCase,
} from './index';

/** Gateway em memoria: guarda a OS por numero e conta updates. */
function fakeGateway(os?: OrdemDeServico) {
  const store = new Map<string, OrdemDeServico>();
  if (os) store.set(os.numero, os);
  const g = {
    updates: 0,
    findByNumero: jest.fn(async (n: string) => store.get(n) ?? null),
    update: jest.fn(async (o: OrdemDeServico) => { g.updates++; store.set(o.numero, o); return o; }),
  } as unknown as OrdemDeServicoGateway & { updates: number };
  return g;
}
const comId = (os: OrdemDeServico) =>
  OrdemDeServico.reconstitute({
    id: 'os-id', numero: os.numero, clienteId: os.clienteId, veiculoId: os.veiculoId, mecanicoId: os.mecanicoId, descricaoInicial: os.descricaoInicial,
    diagnostico: os.diagnostico, status: os.status, motivoCancelamento: os.motivoCancelamento, createdAt: new Date(), updatedAt: new Date(), itensServico: [...os.itensServico],
  });
const nova = (status = StatusOS.RECEBIDA) => {
  const os = OrdemDeServico.create({ clienteId: 'cli-1', veiculoId: 'vei-1', descricaoInicial: 'Barulho ao frenar' });
  if (status !== StatusOS.RECEBIDA) os.iniciarDiagnostico();
  if ([StatusOS.AGUARDANDO_APROVACAO, StatusOS.EM_EXECUCAO, StatusOS.AGUARDANDO_PAGAMENTO, StatusOS.FINALIZADA].includes(status)) {
    os.registrarDiagnostico({ diagnostico: 'Pastilhas gastas', mecanicoId: 'mec-1', itens: [] }); os.aguardarAprovacao();
  }
  if ([StatusOS.EM_EXECUCAO, StatusOS.AGUARDANDO_PAGAMENTO, StatusOS.FINALIZADA].includes(status)) os.iniciarExecucao();
  if ([StatusOS.AGUARDANDO_PAGAMENTO, StatusOS.FINALIZADA].includes(status)) os.aguardarPagamento();
  if (status === StatusOS.FINALIZADA) os.finalizar();
  return comId(os);
};

describe('transicoes dirigidas por eventos (idempotentes — ADR-0009)', () => {
  let events: FakeDomainEventPublisher;
  beforeEach(() => { events = new FakeDomainEventPublisher(); });

  it('execucao.enfileirada -> EM_DIAGNOSTICO e publica a mudanca de status', async () => {
    const os = nova(); const g = fakeGateway(os);
    const r = await new RegistrarEnfileiramentoUseCase(g, events).execute({ numero: os.numero });
    expect(r.status).toBe(StatusOS.EM_DIAGNOSTICO);
    const alterado = events.publicados.find((e) => e instanceof OsStatusAlteradoEvent);
    expect(alterado).toMatchObject({ statusAnterior: StatusOS.RECEBIDA, statusAtual: StatusOS.EM_DIAGNOSTICO, numero: os.numero });
    // audit log: toda transicao gera uma acao rastreavel
    expect(events.publicados.find((e) => e instanceof OsAcaoEvent)).toMatchObject({ acao: 'RECEBIDA -> EM_DIAGNOSTICO', statusNovo: StatusOS.EM_DIAGNOSTICO });
  });

  it('reentrega do mesmo evento nao reaplica nem publica (idempotencia)', async () => {
    const os = nova(StatusOS.EM_DIAGNOSTICO); const g = fakeGateway(os);
    await new RegistrarEnfileiramentoUseCase(g, events).execute({ numero: os.numero });
    expect(g.updates).toBe(0);
    expect(events.publicados).toHaveLength(0);
  });

  it('OS inexistente -> erro de dominio NOT_FOUND', async () => {
    await expect(new RegistrarEnfileiramentoUseCase(fakeGateway(), events).execute({ numero: 'OS-X' })).rejects.toThrow(OrdemDeServicoNotFoundError);
  });

  it('evento fora de ordem (status incompativel) lanca transicao invalida — vai para a DLQ', async () => {
    const os = nova(StatusOS.RECEBIDA); const g = fakeGateway(os);
    await expect(new RegistrarExecucaoIniciadaUseCase(g, events).execute({ numero: os.numero })).rejects.toThrow(InvalidStatusTransitionError);
  });

  it('execucao.diagnostico-concluido grava snapshot agrupando produtos sob o servico pai', async () => {
    const os = nova(StatusOS.EM_DIAGNOSTICO); const g = fakeGateway(os);
    const r = await new RegistrarDiagnosticoUseCase(g, events).execute({
      numero: os.numero, mecanicoId: 'mec-1', diagnostico: 'Pastilhas gastas e oleo vencido',
      itens: [
        { tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca de pastilha', quantidade: 1, precoUnitario: '200.00' },
        { tipo: 'PRODUTO', referenciaId: 'prd-1', nome: 'Pastilha', quantidade: 2, precoUnitario: '50.00', servicoId: 'srv-1' },
        { tipo: 'PRODUTO', referenciaId: 'prd-9', nome: 'Aditivo', quantidade: 1, precoUnitario: 15 },
      ],
    });
    expect(r.mecanicoId).toBe('mec-1');
    expect(r.itensServico.map((i) => [i.nome, i.produtos.length])).toEqual([['Troca de pastilha', 1], ['Pecas avulsas', 1]]);
    // audit log: diagnostico e uma acao rastreavel mesmo sem mudar o status
    expect(events.ultimo<OsAcaoEvent>()).toMatchObject({ acao: 'DIAGNOSTICO_REGISTRADO', usuarioId: 'mec-1', metadata: { itens: 2 } });
    expect(r.valorTotal()).toBe(200 + 100 + 15);
  });

  it('billing.orcamento-gerado -> AGUARDANDO_APROVACAO + OrcamentoProntoEvent com o total do Billing', async () => {
    const os = nova(StatusOS.EM_DIAGNOSTICO); const g = fakeGateway(os);
    await new RegistrarOrcamentoGeradoUseCase(g, events).execute({ numero: os.numero, total: '315.00' });
    const orc = events.publicados.find((e) => e instanceof OrcamentoProntoEvent) as OrcamentoProntoEvent;
    expect(orc).toMatchObject({ numero: os.numero, clienteId: 'cli-1', valorTotal: 315 });
    // reentrega: nada publicado de novo
    events.limpar();
    await new RegistrarOrcamentoGeradoUseCase(g, events).execute({ numero: os.numero, total: '315.00' });
    expect(events.publicados).toHaveLength(0);
  });

  it('execucao.iniciada -> EM_EXECUCAO direto de AGUARDANDO_APROVACAO (a aprovacao nao muda a OS)', async () => {
    const os = nova(StatusOS.AGUARDANDO_APROVACAO); const g = fakeGateway(os);
    expect((await new RegistrarExecucaoIniciadaUseCase(g, events).execute({ numero: os.numero })).status).toBe(StatusOS.EM_EXECUCAO);
  });

  it('execucao.finalizada -> AGUARDANDO_PAGAMENTO, sem OsFinalizadaEvent (a cobranca vem depois da execucao)', async () => {
    const os = nova(StatusOS.EM_EXECUCAO); const g = fakeGateway(os);
    const uc = new RegistrarExecucaoFinalizadaUseCase(g, events);
    expect((await uc.execute({ numero: os.numero })).status).toBe(StatusOS.AGUARDANDO_PAGAMENTO);
    expect(events.publicados.find((e) => e instanceof OsStatusAlteradoEvent)).toMatchObject({ statusAnterior: StatusOS.EM_EXECUCAO, statusAtual: StatusOS.AGUARDANDO_PAGAMENTO });
    expect(events.publicados.filter((e) => e instanceof OsFinalizadaEvent)).toHaveLength(0);
    await uc.execute({ numero: os.numero });
    expect(g.updates).toBe(1);
  });

  it('billing.pagamento-aprovado -> FINALIZADA + OsFinalizadaEvent (uma vez)', async () => {
    const os = nova(StatusOS.AGUARDANDO_PAGAMENTO); const g = fakeGateway(os);
    const uc = new RegistrarPagamentoAprovadoUseCase(g, events);
    const r = await uc.execute({ numero: os.numero }); await uc.execute({ numero: os.numero });
    expect(r.status).toBe(StatusOS.FINALIZADA);
    expect(events.publicados.filter((e) => e instanceof OsFinalizadaEvent)).toHaveLength(1);
  });

  it('compensacao: cancelamento com motivo da saga', async () => {
    const os = nova(StatusOS.AGUARDANDO_APROVACAO); const g = fakeGateway(os);
    const r = await new RegistrarCancelamentoUseCase(g, events).execute({ numero: os.numero, motivo: MotivoCancelamento.ORCAMENTO_REJEITADO });
    expect(r.status).toBe(StatusOS.CANCELADA);
    expect(r.motivoCancelamento).toBe(MotivoCancelamento.ORCAMENTO_REJEITADO);
    // reentrega e no-op mesmo com motivo diferente
    expect((await new RegistrarCancelamentoUseCase(g, events).execute({ numero: os.numero, motivo: MotivoCancelamento.OPERADOR })).motivoCancelamento).toBe(MotivoCancelamento.ORCAMENTO_REJEITADO);
  });

  it('compensacao depois da execucao (AGUARDANDO_PAGAMENTO) e rejeitada: nao ha rollback do servico executado', async () => {
    const os = nova(StatusOS.AGUARDANDO_PAGAMENTO); const g = fakeGateway(os);
    await expect(new RegistrarCancelamentoUseCase(g, events).execute({ numero: os.numero, motivo: MotivoCancelamento.OPERADOR })).rejects.toThrow(InvalidStatusTransitionError);
    expect(g.updates).toBe(0);
  });
});
