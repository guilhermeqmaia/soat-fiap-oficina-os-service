import { Logger } from '@nestjs/common';
import { FakeDomainEventPublisher } from '@guilhermeqmaia/oficina-kit/testing';
import { EventosDaTransacao } from '../../application/eventos-da-transacao';
import { OrdemDeServico } from '../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../domain/value-objects/status-os.vo';
import { MotivoCancelamento } from '../../domain/value-objects/motivo-cancelamento';
import { OrdemDeServicoNotFoundError } from '../../domain/errors/ordem-de-servico-not-found.error';
import { InvalidStatusTransitionError } from '../../domain/errors/invalid-status-transition.error';
import { PassoSaga, SagaOS, StatusSaga } from '../domain/saga-os.entity';
import { ItemServicoOS } from '../../domain/value-objects/item-servico-os.vo';
import { ItemProdutoOS } from '../../domain/value-objects/item-produto-os.vo';
import { OrquestradorSagaService, idDoFato, prazosDoAmbiente } from './orquestrador-saga.service';
import { MarcoOrdemDeServicoEvent } from '../../../shared/domain/events/marco-ordem-de-servico.event';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { SagaTimeoutsService } from './saga-timeouts.service';
import { FakeParticipantesSaga } from '../../../test/fake-participantes-saga';
import { sagaPassos } from '../../../observabilidade/metrics.registry';

/** Repositorio em memoria que reproduz o contrato (lock otimista por version; cada leitura devolve uma copia, como o banco). */
function fakeRepo() {
  const store = new Map<string, SagaOS>();
  const copia = (s: SagaOS, version = s.version) =>
    SagaOS.reconstitute({
      id: s.id ?? 'id-' + s.numero, numero: s.numero, clienteId: s.clienteId, veiculoId: s.veiculoId, descricaoProblema: s.descricaoProblema,
      passo: s.passo, status: s.status, historico: [...s.historico], compensacoes: s.compensacoes.map((c) => ({ ...c })), prazoAprovacao: s.prazoAprovacao,
      prazoPagamento: s.prazoPagamento, passoDesde: s.passoDesde, falhaSimulada: s.falhaSimulada, version, createdAt: s.createdAt ?? new Date(), updatedAt: new Date(),
    });
  return {
    store,
    findByNumero: jest.fn(async (n: string) => { const s = store.get(n); return s ? copia(s) : null; }),
    save: jest.fn(async (s: SagaOS) => {
      const salva = copia(s, s.version + 1);
      store.set(s.numero, salva); return copia(salva);
    }),
    deleteByNumero: jest.fn(async (n: string) => { store.delete(n); }),
    countParadasDesde: jest.fn(async () => 0),
    findComPrazoVencido: jest.fn(async (agora: Date) => [...store.values()].filter((s) => s.status === StatusSaga.EM_ANDAMENTO && ((s.prazoAprovacao && s.prazoAprovacao <= agora) || (s.prazoPagamento && s.prazoPagamento <= agora)))),
    countPorStatus: jest.fn(async () => { const r: Record<string, number> = {}; for (const s of store.values()) r[s.status] = (r[s.status] ?? 0) + 1; return r; }),
  };
}
const uc = () => ({ execute: jest.fn().mockResolvedValue(undefined) });
/** Unit of work que marca quando ha transacao aberta — os comandos so podem sair fora dela. */
const uow = {
  emTransacao: false,
  executar: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    uow.emTransacao = true;
    try { return await fn('tx'); } finally { uow.emTransacao = false; }
  }),
} as any;
/** Participantes fake que registram se cada comando chegou fora da transacao. */
class Participantes extends FakeParticipantesSaga {
  readonly foraDaTransacao: boolean[] = [];
  override async executar(c: Parameters<FakeParticipantesSaga['executar']>[0]) {
    this.foraDaTransacao.push(!uow.emTransacao);
    return super.executar(c);
  }
}
const ITENS = [{ tipo: 'SERVICO', referenciaId: 's', nome: 'n', quantidade: 1, precoUnitario: '1.00' }];
const ordemProps = (status = StatusOS.RECEBIDA, numero = 'OS-1') => ({ id: 'os-1', numero, clienteId: 'cli-1', veiculoId: 'vei-1', mecanicoId: null, descricaoInicial: 'Barulho ao frenar', diagnostico: null as string | null, status, motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(), itensServico: [] });
const ordem = (status = StatusOS.RECEBIDA, numero = 'OS-1') =>
  OrdemDeServico.reconstitute({ id: 'os-1', numero, clienteId: 'cli-1', veiculoId: 'vei-1', mecanicoId: null, descricaoInicial: 'Barulho ao frenar', diagnostico: null, status, motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(), itensServico: [] });
const contador = async (passo: string, resultado: string) =>
  (await sagaPassos.get()).values.find((v) => v.labels.passo === passo && v.labels.resultado === resultado)?.value ?? 0;

describe('OrquestradorSagaService (participantes por HTTP)', () => {
  let repo: ReturnType<typeof fakeRepo>; let ucs: Record<string, ReturnType<typeof uc>>; let ordens: any; let svc: OrquestradorSagaService; let participantes: Participantes; let publisher: FakeDomainEventPublisher;
  /** Abre a OS como o CriarOrdemDeServicoUseCase faz: saga na transacao, comando depois do commit. */
  const abrir = async (falhaSimulada: PassoSaga | null = null) => {
    const { saga, comandos } = await uow.executar((tx: unknown) => svc.iniciar(ordem(), { descricaoProblema: 'Barulho ao frenar', falhaSimulada }, tx));
    return svc.executarComandos(saga, comandos);
  };
  const ev = (type: string, data: Record<string, unknown> = {}) => svc.processar({ type, id: `env-${type}`, data: { numeroOS: 'OS-1', ...data } });
  const ateAprovado = async () => {
    await abrir();
    await ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS });
    return ev('billing.orcamento-aprovado', { orcamentoId: 'o1' });
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    uow.executar.mockClear();
    repo = fakeRepo();
    participantes = new Participantes();
    publisher = new FakeDomainEventPublisher();
    ucs = { enfileiramento: uc(), diagnostico: uc(), orcamentoGerado: uc(), execucaoIniciada: uc(), execucaoFinalizada: uc(), pagamentoAprovado: uc(), cancelamento: uc() };
    ordens = { findByNumero: jest.fn(async () => null) };
    svc = new OrquestradorSagaService(repo as any, ordens, uow, participantes, ucs.enfileiramento as any, ucs.diagnostico as any, ucs.orcamentoGerado as any, ucs.execucaoIniciada as any, ucs.execucaoFinalizada as any, ucs.pagamentoAprovado as any, ucs.cancelamento as any, publisher);
  });
  afterEach(() => jest.restoreAllMocks());

  it('iniciar cria a saga na transacao e devolve execucao.enfileirar SEM executar; repetir nao duplica', async () => {
    const r = await svc.iniciar(ordem(), { descricaoProblema: 'Barulho ao frenar' }, 'tx');
    expect(r.saga.passo).toBe(PassoSaga.ENFILEIRAR_EXECUCAO);
    expect(r.comandos).toEqual([{ type: 'execucao.enfileirar', data: { numeroOS: 'OS-1', veiculoId: 'vei-1', descricaoProblema: 'Barulho ao frenar' } }]);
    expect(participantes.chamadas).toHaveLength(0);
    expect((await svc.iniciar(ordem(), { descricaoProblema: 'x' }, 'tx')).comandos).toEqual([]);
  });

  it('executarComandos roda DEPOIS do commit e reinjeta a resposta sincrona como evento (enfileirada -> EM_DIAGNOSTICO)', async () => {
    const saga = await abrir();
    expect(participantes.tipos()).toEqual(['execucao.enfileirar']);
    expect(participantes.foraDaTransacao).toEqual([true]);
    expect(saga.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
    expect(ucs.enfileiramento.execute).toHaveBeenCalledWith({ numero: 'OS-1', tx: 'tx', eventos: expect.any(EventosDaTransacao) });
    // iniciar na transacao do chamador + processar(execucao.enfileirada) numa nova transacao
    expect(uow.executar).toHaveBeenCalledTimes(2);
  });

  it('caminho feliz: callbacks + respostas sincronas levam a saga ate CONCLUIDA com a OS FINALIZADA', async () => {
    await abrir();
    const r1 = await svc.processarEvento({ type: 'execucao.diagnostico-concluido', id: 'e2', data: { numeroOS: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS } });
    expect(r1.aplicado).toBe(true);
    expect(ucs.diagnostico.execute).toHaveBeenCalledWith({ numero: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS, tx: 'tx', eventos: expect.any(EventosDaTransacao) });
    // a resposta 201 de POST /orcamentos (billing.orcamento-gerado) ja foi aplicada na mesma requisicao
    expect(r1.saga.passo).toBe(PassoSaga.AGUARDAR_APROVACAO);
    expect(ucs.orcamentoGerado.execute).toHaveBeenCalledWith({ numero: 'OS-1', total: '1.00', tx: 'tx', eventos: expect.any(EventosDaTransacao) });
    expect(participantes.de('billing.gerar-orcamento')[0].data).toEqual({ numeroOS: 'OS-1', clienteId: 'cli-1', itens: ITENS });
    expect(participantes.foraDaTransacao.every(Boolean)).toBe(true);

    const r2 = await ev('billing.orcamento-aprovado', { orcamentoId: 'o1' });
    expect(r2.passo).toBe(PassoSaga.AGUARDAR_FINALIZACAO);
    expect(ucs.execucaoIniciada.execute).toHaveBeenCalledWith({ numero: 'OS-1', tx: 'tx', eventos: expect.any(EventosDaTransacao) });

    const r3 = await ev('execucao.finalizada', { finalizadaEm: new Date().toISOString() });
    expect(ucs.execucaoFinalizada.execute).toHaveBeenCalledWith({ numero: 'OS-1', tx: 'tx', eventos: expect.any(EventosDaTransacao) });
    expect(r3.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
    expect(r3.prazoPagamento).toBeTruthy();
    expect(ucs.pagamentoAprovado.execute).not.toHaveBeenCalled();

    const fim = await ev('billing.pagamento-aprovado', { orderId: 'mp-1', valor: '1.00' });
    expect(ucs.pagamentoAprovado.execute).toHaveBeenCalledWith({ numero: 'OS-1', tx: 'tx', eventos: expect.any(EventosDaTransacao) });
    expect(fim.status).toBe(StatusSaga.CONCLUIDA);
    expect(participantes.tipos()).toEqual(['execucao.enfileirar', 'billing.gerar-orcamento', 'execucao.iniciar', 'billing.cobrar']);
  });

  it('evento ignorado: aplicado=false, nao toca a OS, nao chama participante, mas persiste o historico', async () => {
    await abrir();
    const r = await svc.processarEvento({ type: 'execucao.iniciada', id: 'x', data: { numeroOS: 'OS-1' } });
    expect(r.aplicado).toBe(false);
    expect(r.motivo).toContain('fora de ordem');
    expect(ucs.execucaoIniciada.execute).not.toHaveBeenCalled();
    expect(r.saga.historico[r.saga.historico.length - 1].resultado).toBe('ignorado');
    expect(participantes.tipos()).toEqual(['execucao.enfileirar']);
  });

  it('409 do POST /execucao/ordens vira execucao.recusada: OS cancelada com EXECUCAO_RECUSADA, saga CANCELADA', async () => {
    participantes.recusar('execucao.enfileirar', 'veiculo ja em execucao');
    const saga = await abrir();
    expect(saga.status).toBe(StatusSaga.CANCELADA);
    expect(ucs.cancelamento.execute).toHaveBeenCalledWith({ numero: 'OS-1', motivo: MotivoCancelamento.EXECUCAO_RECUSADA, tx: 'tx', eventos: expect.any(EventosDaTransacao) });
    expect(ucs.enfileiramento.execute).not.toHaveBeenCalled();
  });

  it('orcamento rejeitado: DELETE /execucao/ordens e a resposta (reservas-liberadas) fecha a compensacao em CANCELADA', async () => {
    await abrir();
    await ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS });
    const s = await ev('billing.orcamento-rejeitado', { orcamentoId: 'o1' });
    expect(ucs.cancelamento.execute).toHaveBeenCalledWith({ numero: 'OS-1', motivo: MotivoCancelamento.ORCAMENTO_REJEITADO, tx: 'tx', eventos: expect.any(EventosDaTransacao) });
    expect(participantes.tipos().slice(-1)).toEqual(['execucao.liberar-reservas']);
    expect(s.status).toBe(StatusSaga.CANCELADA);
    expect(s.compensacoes).toEqual([expect.objectContaining({ comando: 'execucao.liberar-reservas', confirmadaEm: expect.any(String) })]);
  });

  it('cancelamento manual aguardando o inicio da execucao: DELETE /orcamentos e DELETE /execucao/ordens em ordem inversa, confirmados na hora', async () => {
    participantes.indisponivel('execucao.iniciar');
    expect((await ateAprovado()).passo).toBe(PassoSaga.INICIAR_EXECUCAO);
    participantes.restaurar();
    const s = await svc.processar({ type: 'os.cancelamento-manual', data: { numeroOS: 'OS-1', motivo: MotivoCancelamento.OPERADOR } });
    expect(participantes.tipos().slice(-2)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
    expect(participantes.de('billing.cancelar-orcamento')[0].data).toEqual({ numeroOS: 'OS-1', motivo: MotivoCancelamento.OPERADOR });
    expect(s.status).toBe(StatusSaga.CANCELADA);
    expect(s.compensacoes.every((c) => c.confirmadaEm)).toBe(true);
  });

  it('cancelamento manual rejeitado depois da execucao lanca transicao invalida', async () => {
    await ateAprovado();
    await expect(svc.processar({ type: 'os.cancelamento-manual', data: { numeroOS: 'OS-1', motivo: MotivoCancelamento.OPERADOR } })).rejects.toThrow(InvalidStatusTransitionError);
    await ev('execucao.finalizada');
    await expect(svc.processar({ type: 'os.cancelamento-manual', data: { numeroOS: 'OS-1' } })).rejects.toThrow(InvalidStatusTransitionError);
    expect(ucs.cancelamento.execute).not.toHaveBeenCalled();
  });

  it('comando com tentativas esgotadas: saga fica no passo (comando-falhou); reprocessar reenvia por HTTP e a saga avanca', async () => {
    participantes.indisponivel('execucao.enfileirar');
    const antes = await contador(PassoSaga.ENFILEIRAR_EXECUCAO, 'comando-falhou');
    const parada = await abrir();
    expect(parada.passo).toBe(PassoSaga.ENFILEIRAR_EXECUCAO);
    expect(ucs.enfileiramento.execute).not.toHaveBeenCalled();
    expect(await contador(PassoSaga.ENFILEIRAR_EXECUCAO, 'comando-falhou')).toBe(antes + 1);

    participantes.restaurar();
    const { saga, reenviados } = await svc.reprocessar('OS-1');
    expect(reenviados).toEqual(['execucao.enfileirar']);
    expect(saga.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
    expect(participantes.tipos()).toEqual(['execucao.enfileirar', 'execucao.enfileirar']);
    expect(participantes.foraDaTransacao).toEqual([true, true]);
  });

  it('resposta do participante que nao pode ser aplicada e registrada (resposta-falhou) sem derrubar a requisicao', async () => {
    const antes = await contador(PassoSaga.ENFILEIRAR_EXECUCAO, 'resposta-falhou');
    ucs.enfileiramento.execute.mockRejectedValue(new Error('banco fora'));
    const saga = await abrir();
    expect(saga.passo).toBe(PassoSaga.ENFILEIRAR_EXECUCAO);
    expect(await contador(PassoSaga.ENFILEIRAR_EXECUCAO, 'resposta-falhou')).toBe(antes + 1);
  });

  it('pagamento recusado depois da execucao: OS intocada, saga EM_ANDAMENTO; reprocessar reenvia billing.cobrar e registra a nova cobranca', async () => {
    await ateAprovado();
    await ev('execucao.finalizada');
    const s = await ev('billing.pagamento-recusado', { orderId: 'mp-1', motivo: 'cartao recusado' });
    expect(s.status).toBe(StatusSaga.EM_ANDAMENTO); expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
    expect(s.historico[s.historico.length - 1].resultado).toBe('pagamento-pendente');
    expect(ucs.cancelamento.execute).not.toHaveBeenCalled();
    const { saga, reenviados } = await svc.reprocessar('OS-1');
    expect(reenviados).toEqual(['billing.cobrar']);
    expect(participantes.de('billing.cobrar')).toHaveLength(2);
    expect(saga.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
    expect(saga.historico[saga.historico.length - 1].detalhe).toContain('mp-2');
  });

  it('conflito de versao e refeito em processo; apos 3 tentativas o erro sobe', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd' }, 'tx');
    const original = repo.save.getMockImplementation()!;
    repo.save.mockImplementationOnce(async () => { throw new ConcurrentModificationError('saga OS-1'); }).mockImplementationOnce(original);
    uow.executar.mockClear();
    const s = await svc.processar({ type: 'execucao.enfileirada', id: 'e1', data: { numeroOS: 'OS-1' } });
    expect(s.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
    expect(uow.executar).toHaveBeenCalledTimes(2);
    repo.save.mockImplementation(async () => { throw new ConcurrentModificationError('saga OS-1'); });
    await expect(svc.processar({ type: 'execucao.diagnostico-concluido', id: 'e2', data: { numeroOS: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS } })).rejects.toThrow(ConcurrentModificationError);
    repo.save.mockImplementation(original);
  });

  it('OS sem saga e adotada a partir do status; OS RECEBIDA adotada reenvia execucao.enfileirar; OS inexistente -> NOT_FOUND', async () => {
    ordens.findByNumero.mockResolvedValueOnce(ordem(StatusOS.AGUARDANDO_PAGAMENTO));
    const s = await svc.processar({ type: 'billing.pagamento-aprovado', id: 'f', data: { numeroOS: 'OS-1', orderId: 'mp-1', valor: '1.00' } });
    expect(s.status).toBe(StatusSaga.CONCLUIDA);
    expect(ucs.pagamentoAprovado.execute).toHaveBeenCalled();
    // adotada em EM_EXECUCAO: execucao.finalizada -> COBRAR -> POST /orcamentos/{n}/cobrar -> AGUARDAR_PAGAMENTO
    ordens.findByNumero.mockResolvedValueOnce(ordem(StatusOS.EM_EXECUCAO, 'OS-2'));
    const s2 = await svc.processar({ type: 'execucao.finalizada', id: 'f2', data: { numeroOS: 'OS-2' } });
    expect(s2.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
    expect(participantes.de('billing.cobrar', 'OS-2')).toHaveLength(1);
    // adotada em RECEBIDA por um evento ignorado: o enfileirar pendente sai assim mesmo
    ordens.findByNumero.mockResolvedValueOnce(ordem(StatusOS.RECEBIDA, 'OS-3'));
    const s3 = await svc.processar({ type: 'billing.pagamento-aprovado', id: 'f3', data: { numeroOS: 'OS-3' } });
    expect(participantes.de('execucao.enfileirar', 'OS-3')).toHaveLength(1);
    expect(s3.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
    await expect(svc.processar({ type: 'execucao.finalizada', data: { numeroOS: 'OS-404' } })).rejects.toThrow(OrdemDeServicoNotFoundError);
  });

  it('falha simulada (demo): o evento de sucesso vira falha no passo marcado e a saga compensa pelos DELETEs', async () => {
    await abrir(PassoSaga.INICIAR_EXECUCAO);
    await ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS });
    const s = await ev('billing.orcamento-aprovado', { orcamentoId: 'o1' });
    expect(ucs.cancelamento.execute).toHaveBeenCalledWith(expect.objectContaining({ motivo: MotivoCancelamento.FALHA_INICIO_EXECUCAO }));
    expect(participantes.tipos().slice(-3)).toEqual(['execucao.iniciar', 'billing.cancelar-orcamento', 'execucao.liberar-reservas']);
    expect(s.status).toBe(StatusSaga.CANCELADA);
    expect(s.falhaSimulada).toBeNull();
  });

  it('reprocessar em GERAR_ORCAMENTO reenvia billing.gerar-orcamento com os itens do snapshot da OS', async () => {
    participantes.indisponivel('billing.gerar-orcamento');
    await abrir();
    await ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS });
    participantes.restaurar();
    const osComItens = OrdemDeServico.reconstitute({
      id: 'os-1', numero: 'OS-1', clienteId: 'cli-1', veiculoId: 'vei-1', mecanicoId: 'm', descricaoInicial: 'Barulho ao frenar', diagnostico: 'Pastilhas', status: StatusOS.EM_DIAGNOSTICO,
      motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(),
      itensServico: [new ItemServicoOS('srv-1', 'Troca', 1, 200, [new ItemProdutoOS('prd-1', 'Pastilha', 2, 50)])],
    });
    ordens.findByNumero.mockResolvedValueOnce(osComItens);
    const { reenviados, saga } = await svc.reprocessar('OS-1');
    expect(reenviados).toEqual(['billing.gerar-orcamento']);
    expect(participantes.de('billing.gerar-orcamento')[1].data.itens).toEqual([
      { tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca', quantidade: 1, precoUnitario: '200.00' },
      { tipo: 'PRODUTO', referenciaId: 'prd-1', nome: 'Pastilha', quantidade: 2, precoUnitario: '50.00', servicoId: 'srv-1' },
    ]);
    expect(saga.passo).toBe(PassoSaga.AGUARDAR_APROVACAO);
    await expect(svc.reprocessar('OS-404')).rejects.toThrow('nao encontrada');
  });

  describe('marcos para a notificacao (US-F4-12)', () => {
    const marcos = () => publisher.publicados.filter((e): e is MarcoOrdemDeServicoEvent => e instanceof MarcoOrdemDeServicoEvent);
    beforeEach(() => {
      const comId = OrdemDeServico.reconstitute({ ...ordemProps(), diagnostico: 'Pastilhas gastas' });
      ordens.findByNumero.mockImplementation(async () => comId);
    });

    it('respostas sincronas: orcamento-gerado (total + diagnostico) e cobranca-criada (linkPagamento) com id deterministico', async () => {
      await ateAprovado();
      await ev('execucao.finalizada');
      const tipos = marcos().map((m) => m.type);
      expect(tipos).toEqual(['billing.orcamento-gerado', 'billing.orcamento-aprovado', 'billing.cobranca-criada']);
      const [gerado, aprovado, cobranca] = marcos();
      expect(gerado).toMatchObject({ numeroOS: 'OS-1', ordemDeServicoId: 'os-1', clienteId: 'cli-1', eventoId: 'billing.orcamento-gerado:OS-1:orc-OS-1', dados: { total: 1, diagnostico: 'Pastilhas gastas' } });
      // callback: id do envelope; aprovacao sem link
      expect(aprovado.eventoId).toBe('env-billing.orcamento-aprovado');
      expect(aprovado.dados.linkPagamento).toBeUndefined();
      // o link da resposta 201 do cobrar deixa de ser descartado
      expect(cobranca).toMatchObject({ eventoId: 'billing.cobranca-criada:OS-1:mp-1', dados: { linkPagamento: 'https://mp.test/pay/mp-1', valor: '300.00' } });
    });

    it('pagamento aprovado: marco do Billing antes do marco os.finalizada (que vem da transicao)', async () => {
      const finalizada = { execute: jest.fn(async (i: { eventos: EventosDaTransacao }) => {
        i.eventos.publish(new MarcoOrdemDeServicoEvent('os.finalizada', 'OS-1', 'os-1', 'cli-1', 'os.finalizada:OS-1'));
      }) };
      (svc as any).pagamentoAprovado = finalizada;
      await ateAprovado();
      await ev('execucao.finalizada');
      publisher.limpar();
      await ev('billing.pagamento-aprovado', { orderId: 'mp-1', valor: '300.00' });
      expect(marcos().map((m) => [m.type, m.eventoId])).toEqual([
        ['billing.pagamento-aprovado', 'env-billing.pagamento-aprovado'],
        ['os.finalizada', 'os.finalizada:OS-1'],
      ]);
    });

    it('pagamento recusado gera marco com motivo; reenvio do mesmo callback (ignorado pela saga) nao gera outro', async () => {
      await ateAprovado();
      await ev('execucao.finalizada');
      publisher.limpar();
      await svc.processarEvento({ type: 'billing.pagamento-recusado', id: 'rec-1', data: { numeroOS: 'OS-1', motivo: 'cartao recusado' } });
      expect(marcos()).toEqual([expect.objectContaining({ type: 'billing.pagamento-recusado', eventoId: 'rec-1', dados: { motivo: 'cartao recusado' } })]);
      publisher.limpar();
      const dup = await svc.processarEvento({ type: 'billing.orcamento-aprovado', id: 'env-billing.orcamento-aprovado', data: { numeroOS: 'OS-1' } });
      expect(dup.aplicado).toBe(false);
      expect(marcos()).toEqual([]);
    });

    it('fatos que nao interessam ao cliente nao geram marco; OS nao encontrada tambem nao', async () => {
      await abrir();
      expect(marcos()).toEqual([]);
      ordens.findByNumero.mockImplementation(async () => null);
      await ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS });
      expect(marcos()).toEqual([]);
    });

    it('idDoFato: envelope > recurso criado > so type+numero', () => {
      expect(idDoFato({ type: 'billing.pagamento-aprovado', id: 'env-9', data: {} }, 'OS-1')).toBe('env-9');
      expect(idDoFato({ type: 'billing.cobranca-criada', data: { orderId: 'mp-7' } }, 'OS-1')).toBe('billing.cobranca-criada:OS-1:mp-7');
      expect(idDoFato({ type: 'billing.orcamento-gerado', data: { orcamentoId: 'o-1' } }, 'OS-1')).toBe('billing.orcamento-gerado:OS-1:o-1');
      expect(idDoFato({ type: 'billing.cobranca-criada', data: {} }, 'OS-1')).toBe('billing.cobranca-criada:OS-1');
    });
  });

  it('prazosDoAmbiente: dias/horas ou override em ms', () => {
    expect(prazosDoAmbiente({})).toEqual({ aprovacaoMs: 3 * 86400000, pagamentoMs: 24 * 3600000 });
    expect(prazosDoAmbiente({ SAGA_TIMEOUT_APROVACAO_DIAS: '1', SAGA_TIMEOUT_PAGAMENTO_MS: '5000' })).toEqual({ aprovacaoMs: 86400000, pagamentoMs: 5000 });
  });

  describe('SagaTimeoutsService', () => {
    it('varrer entrega saga.timeout as sagas vencidas; a compensacao sai por HTTP e e confirmada', async () => {
      process.env.SAGA_TIMEOUT_APROVACAO_MS = '1000';
      await abrir();
      const t0 = new Date();
      await svc.processar({ type: 'execucao.diagnostico-concluido', id: '2', data: { numeroOS: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS } }, t0);
      const relogio = new SagaTimeoutsService(repo as any, svc);
      expect(await relogio.varrer(new Date(t0.getTime() + 500))).toBe(0);
      expect(await relogio.varrer(new Date(t0.getTime() + 1500))).toBe(1);
      expect(ucs.cancelamento.execute).toHaveBeenCalledWith(expect.objectContaining({ motivo: MotivoCancelamento.TIMEOUT_APROVACAO }));
      expect(participantes.tipos().slice(-2)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
      expect(repo.store.get('OS-1')?.status).toBe(StatusSaga.CANCELADA);
      delete process.env.SAGA_TIMEOUT_APROVACAO_MS;
    });
    it('pagamento vencido (pos-execucao): o relogio registra o atraso e nao cancela', async () => {
      process.env.SAGA_TIMEOUT_PAGAMENTO_MS = '1000';
      await ateAprovado();
      const t0 = new Date();
      await svc.processar({ type: 'execucao.finalizada', id: 'f', data: { numeroOS: 'OS-1' } }, t0);
      const relogio = new SagaTimeoutsService(repo as any, svc);
      expect(await relogio.varrer(new Date(t0.getTime() + 1500))).toBe(1);
      const s = repo.store.get('OS-1')!;
      expect(s.status).toBe(StatusSaga.EM_ANDAMENTO); expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO); expect(s.prazoPagamento).toBeNull();
      expect(s.historico[s.historico.length - 1].detalhe).toContain('pagamento em atraso');
      expect(ucs.cancelamento.execute).not.toHaveBeenCalled();
      expect(await relogio.varrer(new Date(t0.getTime() + 3000))).toBe(0);
      delete process.env.SAGA_TIMEOUT_PAGAMENTO_MS;
    });
    it('nao agenda com AGENDADORES_AUTOSTART=false; agenda e limpa o timer caso contrario', () => {
      const r = new SagaTimeoutsService(repo as any, svc);
      const old = process.env.AGENDADORES_AUTOSTART;
      process.env.AGENDADORES_AUTOSTART = 'false'; r.onApplicationBootstrap(); expect((r as any).timer).toBeUndefined();
      delete process.env.AGENDADORES_AUTOSTART; r.onApplicationBootstrap(); expect((r as any).timer).toBeDefined(); r.onApplicationShutdown();
      process.env.AGENDADORES_AUTOSTART = old;
    });
  });
});
