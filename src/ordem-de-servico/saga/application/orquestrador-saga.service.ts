import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrdemDeServico } from '../../domain/ordem-de-servico.entity';
import { OrdemDeServicoNotFoundError } from '../../domain/errors/ordem-de-servico-not-found.error';
import { InvalidStatusTransitionError } from '../../domain/errors/invalid-status-transition.error';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../application/gateways/ordem-de-servico.gateway';
import { UNIT_OF_WORK, UnitOfWork } from '../../application/ports/unit-of-work';
import {
  RegistrarCancelamentoUseCase,
  RegistrarDiagnosticoUseCase,
  RegistrarEnfileiramentoUseCase,
  RegistrarExecucaoFinalizadaUseCase,
  RegistrarExecucaoIniciadaUseCase,
  RegistrarOrcamentoAprovadoUseCase,
  RegistrarOrcamentoGeradoUseCase,
} from '../../application/use-cases/transicoes';
import { EventoSaga, ItemContrato, PassoSaga, Prazos, SagaOS, TransicaoOS } from '../domain/saga-os.entity';
import { SagaNotFoundError } from '../domain/errors/saga-not-found.error';
import { SAGA_REPOSITORY, SagaRepository } from '../domain/saga.repository';
import { sagaPassoDuracao, sagaPassos } from '../../../observabilidade/metrics.registry';

/** Prazos configuraveis por ambiente (demo usa minutos; producao dias/horas). */
export function prazosDoAmbiente(env: NodeJS.ProcessEnv = process.env): Prazos {
  const dias = Number(env.SAGA_TIMEOUT_APROVACAO_DIAS ?? 3);
  const horas = Number(env.SAGA_TIMEOUT_PAGAMENTO_HORAS ?? 24);
  return {
    aprovacaoMs: env.SAGA_TIMEOUT_APROVACAO_MS ? Number(env.SAGA_TIMEOUT_APROVACAO_MS) : dias * 24 * 60 * 60 * 1000,
    pagamentoMs: env.SAGA_TIMEOUT_PAGAMENTO_MS ? Number(env.SAGA_TIMEOUT_PAGAMENTO_MS) : horas * 60 * 60 * 1000,
  };
}

const TENTATIVAS_CONFLITO = 3;

/**
 * Orquestrador da saga (RFC-0005): liga a maquina de estados pura (SagaOS) a
 * persistencia, as transicoes da OS e ao outbox de comandos.
 *
 * Cada evento roda numa UNICA transacao (unit of work): carrega a saga ->
 * aplica (decide) -> transiciona a OS -> grava saga + comandos/eventos no
 * outbox. Ou tudo e gravado, ou nada — nao existe OS cancelada sem
 * compensacao nem comando sem passo. Conflito de lock otimista (outro evento
 * ou o atendente mexeram na mesma OS) e refeito em processo ate 3 vezes;
 * depois disso o erro sobe (409 no HTTP, reentrega no SQS).
 */
@Injectable()
export class OrquestradorSagaService {
  private readonly logger = new Logger(OrquestradorSagaService.name);

  constructor(
    @Inject(SAGA_REPOSITORY) private readonly sagas: SagaRepository,
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly ordens: OrdemDeServicoGateway,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly enfileiramento: RegistrarEnfileiramentoUseCase,
    private readonly diagnostico: RegistrarDiagnosticoUseCase,
    private readonly orcamentoGerado: RegistrarOrcamentoGeradoUseCase,
    private readonly orcamentoAprovado: RegistrarOrcamentoAprovadoUseCase,
    private readonly execucaoIniciada: RegistrarExecucaoIniciadaUseCase,
    private readonly execucaoFinalizada: RegistrarExecucaoFinalizadaUseCase,
    private readonly cancelamento: RegistrarCancelamentoUseCase,
  ) {}

  /**
   * Abertura da OS: cria a saga e grava `execucao.enfileirar` no outbox. Deve
   * rodar na MESMA transacao em que a OS foi criada (`tx` do chamador).
   */
  async iniciar(
    ordem: OrdemDeServico,
    resumo: { descricaoProblema: string; falhaSimulada?: PassoSaga | null },
    tx?: unknown,
  ): Promise<SagaOS> {
    const existente = await this.sagas.findByNumero(ordem.numero, tx);
    if (existente) return existente;
    const saga = SagaOS.iniciar({
      numero: ordem.numero,
      clienteId: ordem.clienteId,
      veiculoId: ordem.veiculoId,
      descricaoProblema: resumo.descricaoProblema,
      falhaSimulada: resumo.falhaSimulada ?? null,
    });
    sagaPassos.inc({ passo: saga.passo, resultado: 'avancou' });
    return this.sagas.save(saga, tx);
  }

  /** Evento de participante, do atendente (`os.cancelamento-manual`) ou do relogio (`saga.timeout`). */
  async processar(evento: EventoSaga, agora: Date = new Date()): Promise<SagaOS> {
    for (let tentativa = 1; ; tentativa++) {
      try {
        return await this.uow.executar((tx) => this.processarNaTransacao(evento, agora, tx));
      } catch (e) {
        if (e instanceof ConcurrentModificationError && tentativa < TENTATIVAS_CONFLITO) {
          this.logger.warn({ msg: 'conflito de versao — refazendo', numeroOS: evento.data.numeroOS, type: evento.type, tentativa });
          continue;
        }
        throw e;
      }
    }
  }

  private async processarNaTransacao(evento: EventoSaga, agora: Date, tx: unknown): Promise<SagaOS> {
    const numero = String(evento.data.numeroOS ?? '');
    const saga = (await this.sagas.findByNumero(numero, tx)) ?? (await this.adotar(numero, agora, tx));
    const passoAntes = saga.passo;
    const entradaNoPasso = saga.passoDesde;

    // Demo (US-F4-11): troca o evento de sucesso pelo de falha no passo marcado.
    const efetivo = saga.simularFalha(evento, agora);
    if (efetivo !== evento) {
      this.logger.warn({ msg: 'falha simulada (demo)', numeroOS: numero, passo: passoAntes, de: evento.type, para: efetivo.type });
      evento = efetivo;
    }

    const resultado = saga.aplicar(evento, agora, prazosDoAmbiente());
    const rotulo = resultado.aplicado ? saga.historico[saga.historico.length - 1]?.resultado ?? 'avancou' : 'ignorado';
    sagaPassos.inc({ passo: passoAntes, resultado: rotulo });

    if (resultado.rejeitado) {
      throw new InvalidStatusTransitionError(passoAntes, 'CANCELADA');
    }
    if (!resultado.aplicado) {
      this.logger.warn({ msg: 'evento ignorado pela saga', numeroOS: numero, type: evento.type, passo: passoAntes, motivo: resultado.motivo });
      return this.sagas.save(saga, tx);
    }

    if (resultado.transicaoOS) await this.transicionar(numero, resultado.transicaoOS, evento, tx);
    const salva = await this.sagas.save(saga, tx);
    if (salva.passo !== passoAntes) {
      sagaPassoDuracao.observe({ passo: passoAntes }, Math.max(0, (agora.getTime() - entradaNoPasso.getTime()) / 1000));
    }
    this.logger.log({
      msg: 'saga avancou',
      numeroOS: numero,
      type: evento.type,
      de: passoAntes,
      para: salva.passo,
      status: salva.status,
      comandos: resultado.comandos.map((c) => c.type),
    });
    return salva;
  }

  /**
   * Retomada manual de uma saga travada (ADMIN, US-F4-11): reenvia o comando
   * do passo atual ou as compensacoes pendentes, via outbox. Nao muda a OS.
   */
  async reprocessar(numero: string, agora: Date = new Date()): Promise<{ saga: SagaOS; reenviados: string[] }> {
    return this.uow.executar(async (tx) => {
      const saga = await this.sagas.findByNumero(numero, tx);
      if (!saga) throw new SagaNotFoundError(numero);
      const ordem = await this.ordens.findByNumero(numero, tx);
      const itens: ItemContrato[] = (ordem?.itensServico ?? []).flatMap((s) => [
        { tipo: 'SERVICO' as const, referenciaId: s.servicoId, nome: s.nome, quantidade: s.quantidade, precoUnitario: s.precoUnitario.toFixed(2) },
        ...s.produtos.map((p) => ({
          tipo: 'PRODUTO' as const,
          referenciaId: p.produtoId,
          nome: p.nome,
          quantidade: p.quantidade,
          precoUnitario: p.precoUnitario.toFixed(2),
          servicoId: s.servicoId,
        })),
      ]);
      const reenviados = saga.reprocessar({ itens }, agora).map((c) => c.type);
      sagaPassos.inc({ passo: saga.passo, resultado: 'reprocessada' });
      const salva = await this.sagas.save(saga, tx);
      this.logger.log({ msg: 'saga reprocessada', numeroOS: numero, passo: salva.passo, status: salva.status, reenviados });
      return { saga: salva, reenviados };
    });
  }

  private async transicionar(numero: string, t: TransicaoOS, evento: EventoSaga, tx: unknown): Promise<void> {
    switch (t.tipo) {
      case 'iniciarDiagnostico':
        await this.enfileiramento.execute({ numero, tx });
        return;
      case 'registrarDiagnostico':
        await this.diagnostico.execute({
          numero,
          mecanicoId: evento.data.mecanicoId,
          diagnostico: evento.data.diagnostico,
          itens: evento.data.itens ?? [],
          tx,
        });
        return;
      case 'aguardarAprovacao':
        await this.orcamentoGerado.execute({ numero, total: evento.data.total, tx });
        return;
      case 'aguardarPagamento':
        await this.orcamentoAprovado.execute({ numero, tx });
        return;
      case 'iniciarExecucao':
        await this.execucaoIniciada.execute({ numero, tx });
        return;
      case 'finalizar':
        await this.execucaoFinalizada.execute({ numero, causationId: evento.id, tx });
        return;
      case 'cancelar':
        await this.cancelamento.execute({ numero, motivo: t.motivo, causationId: evento.id, tx });
        return;
    }
  }

  /** OS sem saga (anterior a US-F4-10): adota o passo equivalente ao status atual. */
  private async adotar(numero: string, agora: Date, tx: unknown): Promise<SagaOS> {
    const ordem = await this.ordens.findByNumero(numero, tx);
    if (!ordem) throw new OrdemDeServicoNotFoundError(numero);
    this.logger.warn({ msg: 'OS sem saga — adotando a partir do status atual', numeroOS: numero, status: ordem.status });
    return this.sagas.save(
      SagaOS.adotar(
        {
          numero,
          clienteId: ordem.clienteId,
          veiculoId: ordem.veiculoId,
          descricaoProblema: ordem.descricaoInicial,
          statusOS: ordem.status,
          temDiagnostico: ordem.diagnostico !== null,
        },
        agora,
      ),
      tx,
    );
  }
}
