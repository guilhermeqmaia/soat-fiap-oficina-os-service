import { Logger } from '@nestjs/common';
import { DomainEvent } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../domain/value-objects/status-os.vo';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { OsStatusAlteradoEvent } from '../../domain/events/os-status-alterado.event';
import { PassoSaga, SagaOS, StatusSaga } from '../domain/saga-os.entity';
import { RegistrarPagamentoAprovadoUseCase } from '../../application/use-cases/transicoes';
import { OrquestradorSagaService } from './orquestrador-saga.service';
import { FakeParticipantesSaga } from '../../../test/fake-participantes-saga';

/**
 * Regressao (diagnostico do FLUXO 3, D7): os eventos de dominio eram publicados
 * DENTRO da transacao. Em conflito de versao o orquestrador refaz a transacao;
 * a tentativa revertida ja tinha disparado os listeners (notificacao fantasma
 * ou duplicada). Os eventos so podem sair depois do commit bem-sucedido, e so
 * os da tentativa que commitou.
 */
describe('OrquestradorSagaService — eventos de dominio so depois do commit', () => {
  const ordemAguardandoPagamento = () =>
    OrdemDeServico.reconstitute({
      id: 'os-1', numero: 'OS-1', clienteId: 'cli-1', veiculoId: 'vei-1', mecanicoId: 'mec-1',
      descricaoInicial: 'Barulho ao frear', diagnostico: 'Pastilhas', status: StatusOS.AGUARDANDO_PAGAMENTO,
      motivoCancelamento: null, createdAt: new Date(), updatedAt: new Date(), itensServico: [],
    });
  const sagaAguardandoPagamento = () =>
    SagaOS.reconstitute({
      id: 'saga-1', numero: 'OS-1', clienteId: 'cli-1', veiculoId: 'vei-1', descricaoProblema: 'Barulho ao frear',
      passo: PassoSaga.AGUARDAR_PAGAMENTO, status: StatusSaga.EM_ANDAMENTO, historico: [], compensacoes: [],
      prazoAprovacao: null, prazoPagamento: new Date(Date.now() + 60_000), passoDesde: new Date(), falhaSimulada: null, version: 1,
    });

  let emTransacao: boolean;
  let publicados: Array<{ evento: DomainEvent; emTransacao: boolean }>;
  let svc: OrquestradorSagaService;
  let saves: number;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    emTransacao = false;
    publicados = [];
    saves = 0;

    // Cada leitura devolve o estado COMMITADO (a tentativa revertida nao deixa rastro), como o banco.
    const ordens = { findByNumero: jest.fn(async () => ordemAguardandoPagamento()), update: jest.fn(async (o: OrdemDeServico) => o) };
    const sagas = {
      findByNumero: jest.fn(async () => sagaAguardandoPagamento()),
      // 1a gravacao: outra operacao alterou a saga no meio -> conflito de versao (rollback + retry).
      save: jest.fn(async (s: SagaOS) => {
        saves += 1;
        if (saves === 1) throw new ConcurrentModificationError('OS-1');
        return s;
      }),
    };
    const uow = {
      executar: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        emTransacao = true;
        try { return await fn('tx'); } finally { emTransacao = false; }
      }),
    };
    const publisher = { publish: jest.fn((evento: DomainEvent) => { publicados.push({ evento, emTransacao }); }) };
    const pagamentoAprovado = new RegistrarPagamentoAprovadoUseCase(ordens as any, publisher);
    const uc = () => ({ execute: jest.fn() }) as any;

    svc = new OrquestradorSagaService(
      sagas as any, ordens as any, uow as any, new FakeParticipantesSaga(),
      uc(), uc(), uc(), uc(), uc(), pagamentoAprovado, uc(),
      publisher,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('conflito de versao + retry: nenhum evento sai dentro da transacao e a tentativa revertida nao publica nada', async () => {
    const r = await svc.processarEvento({ type: 'billing.pagamento-aprovado', id: 'env-pago-1', data: { numeroOS: 'OS-1', orderId: 'mp-1' } });

    expect(r.aplicado).toBe(true);
    expect(saves).toBe(2); // 1a tentativa revertida + 2a commitada

    // nenhum listener pode ver um fato antes do commit
    expect(publicados.filter((p) => p.emTransacao)).toEqual([]);
    // so os eventos da tentativa que commitou: uma unica mudanca de status AGUARDANDO_PAGAMENTO -> FINALIZADA
    const mudancas = publicados.map((p) => p.evento).filter((e): e is OsStatusAlteradoEvent => e instanceof OsStatusAlteradoEvent);
    expect(mudancas).toHaveLength(1);
    expect(mudancas[0].statusAtual).toBe(StatusOS.FINALIZADA);
  });

  it('erro definitivo na transacao: nada e publicado', async () => {
    // 3 conflitos seguidos esgotam o retry
    (svc as any).sagas.save.mockImplementation(async () => { throw new ConcurrentModificationError('OS-1'); });
    await expect(
      svc.processarEvento({ type: 'billing.pagamento-aprovado', id: 'env-x', data: { numeroOS: 'OS-1' } }),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
    expect(publicados).toEqual([]);
  });
});
