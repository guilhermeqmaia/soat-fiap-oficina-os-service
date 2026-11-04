import { Logger } from '@nestjs/common';
import { OrdemDeServico } from '../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../domain/value-objects/status-os.vo';
import { MotivoCancelamento } from '../../domain/value-objects/motivo-cancelamento';
import { OrdemDeServicoNotFoundError } from '../../domain/errors/ordem-de-servico-not-found.error';
import { InvalidStatusTransitionError } from '../../domain/errors/invalid-status-transition.error';
import { PassoSaga, SagaOS, StatusSaga } from '../domain/saga-os.entity';
import { ItemServicoOS } from '../../domain/value-objects/item-servico-os.vo';
import { ItemProdutoOS } from '../../domain/value-objects/item-produto-os.vo';
import { OrquestradorSagaService, prazosDoAmbiente } from './orquestrador-saga.service';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { SagaTimeoutsService } from './saga-timeouts.service';

/** Repositorio em memoria que reproduz o contrato (save grava comandos "no outbox"). */
function fakeRepo() {
  const store = new Map<string, SagaOS>();
  const outbox: Array<{ type: string; data: unknown }> = [];
  return {
    store, outbox,
    findByNumero: jest.fn(async (n: string) => store.get(n) ?? null),
    save: jest.fn(async (s: SagaOS) => {
      for (const c of s.consumirComandos()) outbox.push({ type: c.type, data: c.data });
      const salva = SagaOS.reconstitute({
        id: s.id ?? 'id-' + s.numero, numero: s.numero, clienteId: s.clienteId, veiculoId: s.veiculoId, descricaoProblema: s.descricaoProblema,
        passo: s.passo, status: s.status, historico: [...s.historico], compensacoes: [...s.compensacoes], prazoAprovacao: s.prazoAprovacao,
        prazoPagamento: s.prazoPagamento, passoDesde: s.passoDesde, falhaSimulada: s.falhaSimulada, version: s.version + 1, createdAt: s.createdAt ?? new Date(), updatedAt: new Date(),
      });
      store.set(s.numero, salva); return salva;
    }),
    deleteByNumero: jest.fn(async (n: string) => { store.delete(n); }),
    countParadasDesde: jest.fn(async () => 0),
    findComPrazoVencido: jest.fn(async (agora: Date) => [...store.values()].filter((s) => s.status === StatusSaga.EM_ANDAMENTO && ((s.prazoAprovacao && s.prazoAprovacao <= agora) || (s.prazoPagamento && s.prazoPagamento <= agora)))),
    countPorStatus: jest.fn(async () => { const r: Record<string, number> = {}; for (const s of store.values()) r[s.status] = (r[s.status] ?? 0) + 1; return r; }),
  };
}
const uc = () => ({ execute: jest.fn().mockResolvedValue(undefined) });
const uow = { executar: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn('tx')) } as any;
const ITENS = [{ tipo: 'SERVICO', referenciaId: 's', nome: 'n', quantidade: 1, precoUnitario: '1.00' }];
const ordem = (status = StatusOS.RECEBIDA) =>
  OrdemDeServico.reconstitute({ id: 'os-1', numero: 'OS-1', clienteId: 'cli-1', veiculoId: 'vei-1', mecanicoId: null, descricaoInicial: 'Barulho ao frenar', diagnostico: null, status, motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(), itensServico: [] });

describe('OrquestradorSagaService', () => {
  let repo: ReturnType<typeof fakeRepo>; let ucs: Record<string, ReturnType<typeof uc>>; let ordens: any; let svc: OrquestradorSagaService;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    uow.executar.mockClear();
    repo = fakeRepo();
    ucs = { enfileiramento: uc(), diagnostico: uc(), orcamentoGerado: uc(), execucaoIniciada: uc(), execucaoFinalizada: uc(), pagamentoAprovado: uc(), cancelamento: uc() };
    ordens = { findByNumero: jest.fn(async () => null) };
    svc = new OrquestradorSagaService(repo as any, ordens, uow, ucs.enfileiramento as any, ucs.diagnostico as any, ucs.orcamentoGerado as any, ucs.execucaoIniciada as any, ucs.execucaoFinalizada as any, ucs.pagamentoAprovado as any, ucs.cancelamento as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it('iniciar cria a saga e grava execucao.enfileirar no outbox; repetir nao duplica', async () => {
    const s = await svc.iniciar(ordem(), { descricaoProblema: 'Barulho ao frenar' });
    expect(s.passo).toBe(PassoSaga.ENFILEIRAR_EXECUCAO);
    expect(repo.outbox).toEqual([{ type: 'execucao.enfileirar', data: { numeroOS: 'OS-1', veiculoId: 'vei-1', descricaoProblema: 'Barulho ao frenar' } }]);
    await svc.iniciar(ordem(), { descricaoProblema: 'x' });
    expect(repo.outbox).toHaveLength(1);
  });

  it('processar: aplica a transicao na OS pelo use case certo e grava os comandos', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd' });
    await svc.processar({ type: 'execucao.enfileirada', id: 'e1', data: { numeroOS: 'OS-1', posicaoFila: 1 } });
    expect(ucs.enfileiramento.execute).toHaveBeenCalledWith({ numero: 'OS-1', tx: 'tx' });
    const itens = ITENS;
    await svc.processar({ type: 'execucao.diagnostico-concluido', id: 'e2', data: { numeroOS: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens } });
    expect(ucs.diagnostico.execute).toHaveBeenCalledWith({ numero: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens, tx: 'tx' });
    expect(repo.outbox.map((o) => o.type)).toEqual(['execucao.enfileirar', 'billing.gerar-orcamento']);
    await svc.processar({ type: 'billing.orcamento-gerado', id: 'e3', data: { numeroOS: 'OS-1', total: '1.00' } });
    expect(ucs.orcamentoGerado.execute).toHaveBeenCalledWith({ numero: 'OS-1', total: '1.00', tx: 'tx' });
    // aprovado: nenhum use case de transicao (a OS so muda quando a Execucao confirma o inicio)
    await svc.processar({ type: 'billing.orcamento-aprovado', id: 'e4', data: { numeroOS: 'OS-1', orcamentoId: 'o1' } });
    expect(repo.outbox.map((o) => o.type)).toContain('execucao.iniciar');
    expect(ucs.execucaoIniciada.execute).not.toHaveBeenCalled();
    await svc.processar({ type: 'execucao.iniciada', id: 'e5', data: { numeroOS: 'OS-1' } });
    expect(ucs.execucaoIniciada.execute).toHaveBeenCalledWith({ numero: 'OS-1', tx: 'tx' });
    // executado: AGUARDANDO_PAGAMENTO + billing.cobrar (a cobranca vem depois da execucao)
    const cobrando = await svc.processar({ type: 'execucao.finalizada', id: 'e6', data: { numeroOS: 'OS-1' } });
    expect(ucs.execucaoFinalizada.execute).toHaveBeenCalledWith({ numero: 'OS-1', tx: 'tx' });
    expect(cobrando.passo).toBe(PassoSaga.COBRAR);
    expect(repo.outbox.map((o) => o.type)).toEqual(['execucao.enfileirar', 'billing.gerar-orcamento', 'execucao.iniciar', 'billing.cobrar']);
    const aguardando = await svc.processar({ type: 'billing.cobranca-criada', id: 'e7', data: { numeroOS: 'OS-1', orderId: 'mp-1', linkPagamento: 'https://mp', valor: '1.00' } });
    expect(aguardando.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
    expect(ucs.pagamentoAprovado.execute).not.toHaveBeenCalled();
    const fim = await svc.processar({ type: 'billing.pagamento-aprovado', id: 'e8', data: { numeroOS: 'OS-1', orderId: 'mp-1', valor: '1.00' } });
    expect(ucs.pagamentoAprovado.execute).toHaveBeenCalledWith({ numero: 'OS-1', causationId: 'e8', tx: 'tx' });
    expect(fim.status).toBe(StatusSaga.CONCLUIDA);
    expect(repo.outbox).toHaveLength(4);
  });

  it('pagamento recusado depois da execucao: OS intocada, saga segue EM_ANDAMENTO e reprocessar reenvia billing.cobrar', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd' });
    for (const [t, d] of [['execucao.enfileirada', {}], ['execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS }], ['billing.orcamento-gerado', { total: '1.00' }], ['billing.orcamento-aprovado', {}], ['execucao.iniciada', {}], ['execucao.finalizada', {}], ['billing.cobranca-criada', { orderId: 'mp-1' }]] as const) {
      await svc.processar({ type: t, id: t, data: { numeroOS: 'OS-1', ...d } });
    }
    const s = await svc.processar({ type: 'billing.pagamento-recusado', id: 'pr', data: { numeroOS: 'OS-1', orderId: 'mp-1', motivo: 'cartao recusado' } });
    expect(s.status).toBe(StatusSaga.EM_ANDAMENTO); expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
    expect(s.historico[s.historico.length - 1].resultado).toBe('pagamento-pendente');
    expect(ucs.cancelamento.execute).not.toHaveBeenCalled();
    expect(ucs.pagamentoAprovado.execute).not.toHaveBeenCalled();
    const antes = repo.outbox.length;
    const { reenviados } = await svc.reprocessar('OS-1');
    expect(reenviados).toEqual(['billing.cobrar']);
    expect(repo.outbox[antes]).toEqual({ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } });
  });

  it('evento ignorado: nao toca a OS, mas persiste o historico', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd' });
    const s = await svc.processar({ type: 'execucao.iniciada', id: 'x', data: { numeroOS: 'OS-1' } });
    expect(ucs.execucaoIniciada.execute).not.toHaveBeenCalled();
    expect(s.historico[s.historico.length - 1].resultado).toBe('ignorado');
  });

  it('compensacao: cancela a OS com motivo e causationId e envia os comandos', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd' });
    await svc.processar({ type: 'execucao.enfileirada', id: 'e1', data: { numeroOS: 'OS-1' } });
    await svc.processar({ type: 'execucao.diagnostico-concluido', id: 'e2', data: { numeroOS: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS } });
    await svc.processar({ type: 'billing.orcamento-gerado', id: 'e3', data: { numeroOS: 'OS-1', total: '1.00' } });
    const s = await svc.processar({ type: 'billing.orcamento-rejeitado', id: 'e4', data: { numeroOS: 'OS-1' } });
    expect(ucs.cancelamento.execute).toHaveBeenCalledWith({ numero: 'OS-1', motivo: MotivoCancelamento.ORCAMENTO_REJEITADO, causationId: 'e4', tx: 'tx' });
    expect(s.status).toBe(StatusSaga.COMPENSANDO);
    expect(repo.outbox[repo.outbox.length - 1].type).toBe('execucao.liberar-reservas');
    const fim = await svc.processar({ type: 'execucao.reservas-liberadas', id: 'e5', data: { numeroOS: 'OS-1' } });
    expect(fim.status).toBe(StatusSaga.CANCELADA);
  });

  it('cancelamento manual rejeitado depois da execucao lanca transicao invalida', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd' });
    for (const [t, d] of [['execucao.enfileirada', {}], ['execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS }], ['billing.orcamento-gerado', { total: '1.00' }], ['billing.orcamento-aprovado', {}], ['execucao.iniciada', {}]] as const) {
      await svc.processar({ type: t, id: t, data: { numeroOS: 'OS-1', ...d } });
    }
    await expect(svc.processar({ type: 'os.cancelamento-manual', data: { numeroOS: 'OS-1', motivo: MotivoCancelamento.OPERADOR } })).rejects.toThrow(InvalidStatusTransitionError);
    // tambem depois de executado, aguardando o pagamento
    await svc.processar({ type: 'execucao.finalizada', id: 'f', data: { numeroOS: 'OS-1' } });
    await expect(svc.processar({ type: 'os.cancelamento-manual', data: { numeroOS: 'OS-1' } })).rejects.toThrow(InvalidStatusTransitionError);
    expect(ucs.cancelamento.execute).not.toHaveBeenCalled();
  });

  it('conflito de versao e refeito em processo; apos 3 tentativas o erro sobe', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd' });
    const original = repo.save.getMockImplementation()!;
    repo.save.mockImplementationOnce(async () => { throw new ConcurrentModificationError('saga OS-1'); }).mockImplementationOnce(original);
    const s = await svc.processar({ type: 'execucao.enfileirada', id: 'e1', data: { numeroOS: 'OS-1' } });
    expect(s.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
    // iniciar() roda na transacao do chamador; processar() abriu 2 (uma falhou por conflito, uma concluiu)
    expect(uow.executar).toHaveBeenCalledTimes(2);
    repo.save.mockImplementation(async () => { throw new ConcurrentModificationError('saga OS-1'); });
    await expect(svc.processar({ type: 'execucao.diagnostico-concluido', id: 'e2', data: { numeroOS: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS } })).rejects.toThrow(ConcurrentModificationError);
    repo.save.mockImplementation(original);
  });

  it('OS sem saga e adotada a partir do status; OS inexistente -> NOT_FOUND', async () => {
    ordens.findByNumero.mockResolvedValueOnce(ordem(StatusOS.AGUARDANDO_PAGAMENTO));
    const s = await svc.processar({ type: 'billing.pagamento-aprovado', id: 'f', data: { numeroOS: 'OS-1', orderId: 'mp-1', valor: '1.00' } });
    expect(s.status).toBe(StatusSaga.CONCLUIDA);
    expect(ucs.pagamentoAprovado.execute).toHaveBeenCalled();
    ordens.findByNumero.mockResolvedValueOnce(ordem(StatusOS.EM_EXECUCAO));
    const s2 = await svc.processar({ type: 'execucao.finalizada', id: 'f2', data: { numeroOS: 'OS-2' } });
    expect(s2.passo).toBe(PassoSaga.COBRAR);
    expect(repo.outbox[repo.outbox.length - 1]).toEqual({ type: 'billing.cobrar', data: { numeroOS: 'OS-2' } });
    await expect(svc.processar({ type: 'execucao.finalizada', data: { numeroOS: 'OS-404' } })).rejects.toThrow(OrdemDeServicoNotFoundError);
  });

  it('falha simulada (demo): o evento de sucesso vira falha no passo marcado e a saga compensa', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd', falhaSimulada: PassoSaga.INICIAR_EXECUCAO });
    for (const [t, d] of [['execucao.enfileirada', {}], ['execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS }], ['billing.orcamento-gerado', { total: '1.00' }], ['billing.orcamento-aprovado', {}]] as const) {
      await svc.processar({ type: t, id: t, data: { numeroOS: 'OS-1', ...d } });
    }
    const s = await svc.processar({ type: 'execucao.iniciada', id: 'ei', data: { numeroOS: 'OS-1' } });
    expect(s.status).toBe(StatusSaga.COMPENSANDO);
    expect(ucs.cancelamento.execute).toHaveBeenCalledWith(expect.objectContaining({ motivo: MotivoCancelamento.FALHA_INICIO_EXECUCAO }));
    expect(repo.outbox.slice(-2).map((o) => o.type)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
    expect(s.falhaSimulada).toBeNull();
  });

  it('reprocessar reenvia o comando do passo (com itens do snapshot da OS) e nao toca a OS', async () => {
    await svc.iniciar(ordem(), { descricaoProblema: 'd' });
    await svc.processar({ type: 'execucao.enfileirada', id: 'e1', data: { numeroOS: 'OS-1' } });
    await svc.processar({ type: 'execucao.diagnostico-concluido', id: 'e2', data: { numeroOS: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS } });
    const osComItens = OrdemDeServico.reconstitute({
      id: 'os-1', numero: 'OS-1', clienteId: 'cli-1', veiculoId: 'vei-1', mecanicoId: 'm', descricaoInicial: 'Barulho ao frenar', diagnostico: 'Pastilhas', status: StatusOS.EM_DIAGNOSTICO,
      motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(),
      itensServico: [new ItemServicoOS('srv-1', 'Troca', 1, 200, [new ItemProdutoOS('prd-1', 'Pastilha', 2, 50)])],
    });
    ordens.findByNumero.mockResolvedValueOnce(osComItens);
    const antes = repo.outbox.length;
    const { reenviados, saga } = await svc.reprocessar('OS-1');
    expect(reenviados).toEqual(['billing.gerar-orcamento']);
    expect(repo.outbox).toHaveLength(antes + 1);
    expect((repo.outbox[antes].data as any).itens).toEqual([
      { tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca', quantidade: 1, precoUnitario: '200.00' },
      { tipo: 'PRODUTO', referenciaId: 'prd-1', nome: 'Pastilha', quantidade: 2, precoUnitario: '50.00', servicoId: 'srv-1' },
    ]);
    expect(saga.passo).toBe(PassoSaga.GERAR_ORCAMENTO);
    expect(Object.values(ucs).filter((u) => u !== ucs.enfileiramento && u !== ucs.diagnostico).every((u) => u.execute.mock.calls.length === 0)).toBe(true);
    await expect(svc.reprocessar('OS-404')).rejects.toThrow('nao encontrada');
  });

  it('prazosDoAmbiente: dias/horas ou override em ms', () => {
    expect(prazosDoAmbiente({})).toEqual({ aprovacaoMs: 3 * 86400000, pagamentoMs: 24 * 3600000 });
    expect(prazosDoAmbiente({ SAGA_TIMEOUT_APROVACAO_DIAS: '1', SAGA_TIMEOUT_PAGAMENTO_MS: '5000' })).toEqual({ aprovacaoMs: 86400000, pagamentoMs: 5000 });
  });

  describe('SagaTimeoutsService', () => {
    it('varrer entrega saga.timeout as sagas vencidas e atualiza a gauge', async () => {
      process.env.SAGA_TIMEOUT_APROVACAO_MS = '1000';
      await svc.iniciar(ordem(), { descricaoProblema: 'd' });
      await svc.processar({ type: 'execucao.enfileirada', id: '1', data: { numeroOS: 'OS-1' } });
      await svc.processar({ type: 'execucao.diagnostico-concluido', id: '2', data: { numeroOS: 'OS-1', mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS } });
      const t0 = new Date();
      await svc.processar({ type: 'billing.orcamento-gerado', id: '3', data: { numeroOS: 'OS-1', total: '1.00' } }, t0);
      const relogio = new SagaTimeoutsService(repo as any, svc);
      expect(await relogio.varrer(new Date(t0.getTime() + 500))).toBe(0);
      expect(await relogio.varrer(new Date(t0.getTime() + 1500))).toBe(1);
      expect(ucs.cancelamento.execute).toHaveBeenCalledWith(expect.objectContaining({ motivo: MotivoCancelamento.TIMEOUT_APROVACAO }));
      expect(repo.store.get('OS-1')?.status).toBe(StatusSaga.COMPENSANDO);
      delete process.env.SAGA_TIMEOUT_APROVACAO_MS;
    });
    it('pagamento vencido (pos-execucao): o relogio registra o atraso e nao cancela', async () => {
      process.env.SAGA_TIMEOUT_PAGAMENTO_MS = '1000';
      await svc.iniciar(ordem(), { descricaoProblema: 'd' });
      for (const [t, d] of [['execucao.enfileirada', {}], ['execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS }], ['billing.orcamento-gerado', { total: '1.00' }], ['billing.orcamento-aprovado', {}], ['execucao.iniciada', {}], ['execucao.finalizada', {}]] as const) {
        await svc.processar({ type: t, id: t, data: { numeroOS: 'OS-1', ...d } });
      }
      const t0 = new Date();
      await svc.processar({ type: 'billing.cobranca-criada', id: 'cc', data: { numeroOS: 'OS-1', orderId: 'mp-1' } }, t0);
      const relogio = new SagaTimeoutsService(repo as any, svc);
      expect(await relogio.varrer(new Date(t0.getTime() + 1500))).toBe(1);
      const s = repo.store.get('OS-1')!;
      expect(s.status).toBe(StatusSaga.EM_ANDAMENTO); expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO); expect(s.prazoPagamento).toBeNull();
      expect(s.historico[s.historico.length - 1].detalhe).toContain('pagamento em atraso');
      expect(ucs.cancelamento.execute).not.toHaveBeenCalled();
      // segunda varredura nao reencontra a saga
      expect(await relogio.varrer(new Date(t0.getTime() + 3000))).toBe(0);
      delete process.env.SAGA_TIMEOUT_PAGAMENTO_MS;
    });
    it('nao agenda com MESSAGING_AUTOSTART=false; agenda e limpa o timer caso contrario', () => {
      const r = new SagaTimeoutsService(repo as any, svc);
      const old = process.env.MESSAGING_AUTOSTART;
      process.env.MESSAGING_AUTOSTART = 'false'; r.onApplicationBootstrap(); expect((r as any).timer).toBeUndefined();
      delete process.env.MESSAGING_AUTOSTART; r.onApplicationBootstrap(); expect((r as any).timer).toBeDefined(); r.onApplicationShutdown();
      process.env.MESSAGING_AUTOSTART = old;
    });
  });
});
