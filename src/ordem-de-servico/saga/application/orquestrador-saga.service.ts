import { Inject, Injectable, Logger } from '@nestjs/common';
import { DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../domain/ordem-de-servico.entity';
import { OrdemDeServicoNotFoundError } from '../../domain/errors/ordem-de-servico-not-found.error';
import { InvalidStatusTransitionError } from '../../domain/errors/invalid-status-transition.error';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../application/gateways/ordem-de-servico.gateway';
import { UNIT_OF_WORK, UnitOfWork } from '../../application/ports/unit-of-work';
import { EventosDaTransacao } from '../../application/eventos-da-transacao';
import {
  DadosMarcoOS,
  MarcoOrdemDeServicoEvent,
  TIPOS_MARCO_BILLING,
  TipoMarcoOS,
} from '../../../shared/domain/events/marco-ordem-de-servico.event';
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

/**
 * Id do fato para a deduplicacao das notificacoes (US-F4-12): o `id` do envelope
 * quando o fato veio por callback; para respostas sincronas (sem envelope), um id
 * deterministico com o recurso criado pelo participante (`orderId` de cada
 * cobranca, `orcamentoId`) — um retry da mesma resposta gera o mesmo id, uma
 * cobranca nova (outro `orderId`) gera outro.
 */
export function idDoFato(evento: EventoSaga, numero: string): string {
  if (evento.id) return evento.id;
  const recurso = evento.data.orderId ?? evento.data.orcamentoId ?? evento.data.pagamentoId;
  return [evento.type, numero, recurso].filter((p) => p !== undefined && p !== null && p !== '').join(':');
}

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
 * Eventos de dominio (notificacao, auditoria, metricas) tambem so saem DEPOIS
 * do commit: cada tentativa acumula os seus num `EventosDaTransacao`, que e
 * descartado se a transacao reverter (conflito de versao -> retry) e
 * descarregado no publisher quando ela commita. Quando a saga aceita um fato
 * `billing.*` que interessa ao cliente, o orquestrador gera o
 * `MarcoOrdemDeServicoEvent` correspondente (US-F4-12).
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
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
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
        // Coletor novo por tentativa: o de uma tentativa revertida e descartado sem publicar nada.
        const eventos = new EventosDaTransacao();
        const resultado = await this.uow.executar((tx) => this.processarNaTransacao(evento, agora, tx, eventos));
        eventos.descarregarEm(this.events); // commit bem-sucedido -> listeners
        return resultado;
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
    eventos: EventosDaTransacao,
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

    // Fato do Billing aceito pela saga -> marco para a notificacao (antes da transicao: "pagamento
    // aprovado" vem antes de "OS finalizada"). Duplicado/fora de ordem ja saiu acima, sem marco.
    await this.registrarMarcoDoBilling(numero, evento, tx, eventos);
    if (resultado.transicaoOS) await this.transicionar(numero, resultado.transicaoOS, evento, tx, eventos);
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

  private async registrarMarcoDoBilling(numero: string, evento: EventoSaga, tx: unknown, eventos: EventosDaTransacao): Promise<void> {
    if (!TIPOS_MARCO_BILLING.has(evento.type)) return;
    const ordem = await this.ordens.findByNumero(numero, tx);
    if (!ordem?.id) return;
    const d = evento.data;
    const texto = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
    const dados: DadosMarcoOS = {
      linkPagamento: texto(d.linkPagamento),
      total: d.total !== undefined && d.total !== null ? Number(d.total) : undefined,
      diagnostico: evento.type === 'billing.orcamento-gerado' ? ordem.diagnostico ?? undefined : undefined,
      motivo: texto(d.motivo),
      valor: texto(d.valor),
    };
    for (const k of Object.keys(dados) as Array<keyof DadosMarcoOS>) if (dados[k] === undefined) delete dados[k];
    eventos.publish(
      new MarcoOrdemDeServicoEvent(evento.type as TipoMarcoOS, numero, ordem.id, ordem.clienteId, idDoFato(evento, numero), dados),
    );
  }

  private async transicionar(numero: string, t: TransicaoOS, evento: EventoSaga, tx: unknown, eventos: EventosDaTransacao): Promise<void> {
    switch (t.tipo) {
      case 'iniciarDiagnostico':
        await this.enfileiramento.execute({ numero, tx, eventos });
        return;
      case 'registrarDiagnostico':
        await this.diagnostico.execute({
          numero,
          mecanicoId: evento.data.mecanicoId,
          diagnostico: evento.data.diagnostico,
          itens: evento.data.itens ?? [],
          tx,
          eventos,
        });
        return;
      case 'aguardarAprovacao':
        await this.orcamentoGerado.execute({ numero, total: evento.data.total, tx, eventos });
        return;
      case 'iniciarExecucao':
        await this.execucaoIniciada.execute({ numero, tx, eventos });
        return;
      case 'aguardarPagamento':
        await this.execucaoFinalizada.execute({ numero, tx, eventos });
        return;
      case 'finalizar':
        await this.pagamentoAprovado.execute({ numero, tx, eventos });
        return;
      case 'cancelar':
        await this.cancelamento.execute({ numero, motivo: t.motivo, tx, eventos });
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
