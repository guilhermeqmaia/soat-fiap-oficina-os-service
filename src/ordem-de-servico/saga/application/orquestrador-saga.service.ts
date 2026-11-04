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
  RegistrarOrcamentoGeradoUseCase,
  RegistrarPagamentoAprovadoUseCase,
} from '../../application/use-cases/transicoes';
import { ComandoSaga, EventoSaga, ItemContrato, PassoSaga, Prazos, SagaOS, TransicaoOS } from '../domain/saga-os.entity';
import { SagaNotFoundError } from '../domain/errors/saga-not-found.error';
import { SAGA_REPOSITORY, SagaRepository } from '../domain/saga.repository';
import { PARTICIPANTES_SAGA_GATEWAY, ParticipantesSagaGateway } from './ports/participantes-saga.gateway';
import { sagaPassoDuracao, sagaPassos } from '../../../observabilidade/metrics.registry';

/**
 * Prazos configuraveis por ambiente (demo usa minutos; producao dias/horas).
 * O de aprovacao compensa; o de pagamento (pos-execucao) so marca o atraso.
 */
export function prazosDoAmbiente(env: NodeJS.ProcessEnv = process.env): Prazos {
  const dias = Number(env.SAGA_TIMEOUT_APROVACAO_DIAS ?? 3);
  const horas = Number(env.SAGA_TIMEOUT_PAGAMENTO_HORAS ?? 24);
  return {
    aprovacaoMs: env.SAGA_TIMEOUT_APROVACAO_MS ? Number(env.SAGA_TIMEOUT_APROVACAO_MS) : dias * 24 * 60 * 60 * 1000,
    pagamentoMs: env.SAGA_TIMEOUT_PAGAMENTO_MS ? Number(env.SAGA_TIMEOUT_PAGAMENTO_MS) : horas * 60 * 60 * 1000,
  };
}

const TENTATIVAS_CONFLITO = 3;

/** Saga gravada + comandos decididos nessa transacao (a executar depois do commit). */
export interface SagaComComandos {
  saga: SagaOS;
  comandos: ComandoSaga[];
}

export interface ResultadoEvento {
  /** Saga DEPOIS de executar os comandos e aplicar as respostas sincronas. */
  saga: SagaOS;
  /** `false` = o evento foi ignorado pela saga (duplicado / fora de ordem). */
  aplicado: boolean;
  motivo?: string;
}

/**
 * Orquestrador da saga (RFC-0005): liga a maquina de estados pura (SagaOS) a
 * persistencia, as transicoes da OS e aos participantes por HTTP (RFC-0008).
 *
 * Cada evento roda numa UNICA transacao (unit of work): carrega a saga ->
 * aplica (decide) -> transiciona a OS -> grava a saga. Ou tudo e gravado, ou
 * nada. Conflito de lock otimista e refeito em processo ate 3 vezes; depois o
 * erro sobe (409 no HTTP — quem chamou o callback repete).
 *
 * Os comandos decididos pela saga sao executados DEPOIS do commit, por HTTP
 * (`ParticipantesSagaGateway`): a resposta sincrona de cada chamada vira o
 * evento correspondente e e reinjetada em `processar` — nova transacao, sem
 * reentrancia dentro da anterior. Se a chamada esgotar as tentativas, a saga
 * fica no passo (metrica `comando-falhou`; `reprocessar` reenvia).
 */
@Injectable()
export class OrquestradorSagaService {
  private readonly logger = new Logger(OrquestradorSagaService.name);

  constructor(
    @Inject(SAGA_REPOSITORY) private readonly sagas: SagaRepository,
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly ordens: OrdemDeServicoGateway,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(PARTICIPANTES_SAGA_GATEWAY) private readonly participantes: ParticipantesSagaGateway,
    private readonly enfileiramento: RegistrarEnfileiramentoUseCase,
    private readonly diagnostico: RegistrarDiagnosticoUseCase,
    private readonly orcamentoGerado: RegistrarOrcamentoGeradoUseCase,
    private readonly execucaoIniciada: RegistrarExecucaoIniciadaUseCase,
    private readonly execucaoFinalizada: RegistrarExecucaoFinalizadaUseCase,
    private readonly pagamentoAprovado: RegistrarPagamentoAprovadoUseCase,
    private readonly cancelamento: RegistrarCancelamentoUseCase,
  ) {}

  /**
   * Abertura da OS: cria a saga na MESMA transacao em que a OS foi criada
   * (`tx` do chamador) e devolve `execucao.enfileirar` para o chamador executar
   * com `executarComandos` DEPOIS do commit.
   */
  async iniciar(
    ordem: OrdemDeServico,
    resumo: { descricaoProblema: string; falhaSimulada?: PassoSaga | null },
    tx?: unknown,
  ): Promise<SagaComComandos> {
    const existente = await this.sagas.findByNumero(ordem.numero, tx);
    if (existente) return { saga: existente, comandos: [] };
    const saga = SagaOS.iniciar({
      numero: ordem.numero,
      clienteId: ordem.clienteId,
      veiculoId: ordem.veiculoId,
      descricaoProblema: resumo.descricaoProblema,
      falhaSimulada: resumo.falhaSimulada ?? null,
    });
    sagaPassos.inc({ passo: saga.passo, resultado: 'avancou' });
    const comandos = saga.consumirComandos();
    return { saga: await this.sagas.save(saga, tx), comandos };
  }

  /** Evento de participante (callback/resposta), do atendente (`os.cancelamento-manual`) ou do relogio (`saga.timeout`). */
  async processar(evento: EventoSaga, agora: Date = new Date()): Promise<SagaOS> {
    return (await this.processarEvento(evento, agora)).saga;
  }

  /** Como `processar`, informando tambem se a saga aceitou o evento (resposta do callback). */
  async processarEvento(evento: EventoSaga, agora: Date = new Date()): Promise<ResultadoEvento> {
    const { saga, comandos, aplicado, motivo } = await this.aplicarComRetry(evento, agora);
    const final = await this.executarComandos(saga, comandos, agora);
    return { saga: final, aplicado, motivo };
  }

  /**
   * Executa por HTTP os comandos decididos pela saga — sempre FORA da transacao
   * que os decidiu — e reinjeta cada resposta como evento (`processar`, nova
   * transacao). Devolve a saga apos a ultima resposta aplicada.
   */
  async executarComandos(saga: SagaOS, comandos: ComandoSaga[], agora: Date = new Date()): Promise<SagaOS> {
    let atual = saga;
    for (const comando of comandos) {
      const resultado = await this.participantes.executar(comando);
      if (resultado.entregue === false) {
        sagaPassos.inc({ passo: atual.passo, resultado: 'comando-falhou' });
        this.logger.error({
          msg: 'comando nao entregue ao participante — saga fica no passo (alerta de saga parada / reprocessar)',
          numeroOS: saga.numero,
          comando: comando.type,
          passo: atual.passo,
          status: resultado.status,
          erro: resultado.erro,
        });
        continue;
      }
      try {
        atual = await this.processar(resultado.evento, agora);
      } catch (e) {
        // O participante ja executou o comando; o que falhou foi aplicar a resposta
        // aqui (ex.: conflito persistente). Reprocessar reenvia (idempotente por numeroOS).
        sagaPassos.inc({ passo: atual.passo, resultado: 'resposta-falhou' });
        this.logger.error({
          msg: 'resposta do participante nao aplicada na saga',
          numeroOS: saga.numero,
          comando: comando.type,
          evento: resultado.evento.type,
          erro: (e as Error).message,
        });
      }
    }
    return atual;
  }

  private async aplicarComRetry(
    evento: EventoSaga,
    agora: Date,
  ): Promise<SagaComComandos & { aplicado: boolean; motivo?: string }> {
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

  private async processarNaTransacao(
    evento: EventoSaga,
    agora: Date,
    tx: unknown,
  ): Promise<SagaComComandos & { aplicado: boolean; motivo?: string }> {
    const numero = String(evento.data.numeroOS ?? '');
    let saga = await this.sagas.findByNumero(numero, tx);
    // OS anterior a saga: adota o passo pelo status; em RECEBIDA ja vem `execucao.enfileirar` a enviar.
    let comandosDaAdocao: ComandoSaga[] = [];
    if (!saga) ({ saga, comandos: comandosDaAdocao } = await this.adotar(numero, agora, tx));
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
      return { saga: await this.sagas.save(saga, tx), comandos: comandosDaAdocao, aplicado: false, motivo: resultado.motivo };
    }

    if (resultado.transicaoOS) await this.transicionar(numero, resultado.transicaoOS, evento, tx);
    const comandos = [...comandosDaAdocao, ...saga.consumirComandos()];
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
      comandos: comandos.map((c) => c.type),
    });
    return { saga: salva, comandos, aplicado: true };
  }

  /**
   * Retomada manual de uma saga travada (ADMIN, US-F4-11): reenvia por HTTP o
   * comando do passo atual ou as compensacoes pendentes. Nao muda a OS por si;
   * a resposta do participante segue o fluxo normal (`processar`).
   */
  async reprocessar(numero: string, agora: Date = new Date()): Promise<{ saga: SagaOS; reenviados: string[] }> {
    const { saga, comandos } = await this.uow.executar(async (tx): Promise<SagaComComandos> => {
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
      saga.reprocessar({ itens }, agora);
      const comandos = saga.consumirComandos();
      sagaPassos.inc({ passo: saga.passo, resultado: 'reprocessada' });
      const salva = await this.sagas.save(saga, tx);
      this.logger.log({ msg: 'saga reprocessada', numeroOS: numero, passo: salva.passo, status: salva.status, reenviados: comandos.map((c) => c.type) });
      return { saga: salva, comandos };
    });
    const final = await this.executarComandos(saga, comandos, agora);
    return { saga: final, reenviados: comandos.map((c) => c.type) };
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
      case 'iniciarExecucao':
        await this.execucaoIniciada.execute({ numero, tx });
        return;
      case 'aguardarPagamento':
        await this.execucaoFinalizada.execute({ numero, tx });
        return;
      case 'finalizar':
        await this.pagamentoAprovado.execute({ numero, tx });
        return;
      case 'cancelar':
        await this.cancelamento.execute({ numero, motivo: t.motivo, tx });
        return;
    }
  }

  /** OS sem saga (anterior a US-F4-10): adota o passo equivalente ao status atual. */
  private async adotar(numero: string, agora: Date, tx: unknown): Promise<SagaComComandos> {
    const ordem = await this.ordens.findByNumero(numero, tx);
    if (!ordem) throw new OrdemDeServicoNotFoundError(numero);
    this.logger.warn({ msg: 'OS sem saga — adotando a partir do status atual', numeroOS: numero, status: ordem.status });
    const saga = SagaOS.adotar(
      {
        numero,
        clienteId: ordem.clienteId,
        veiculoId: ordem.veiculoId,
        descricaoProblema: ordem.descricaoInicial,
        statusOS: ordem.status,
        temDiagnostico: ordem.diagnostico !== null,
      },
      agora,
    );
    // Se a OS esta RECEBIDA, a saga adotada ja traz `execucao.enfileirar` pendente;
    // ele sai com os comandos da transacao corrente (depois do commit).
    const comandos = saga.consumirComandos();
    return { saga: await this.sagas.save(saga, tx), comandos };
  }
}
