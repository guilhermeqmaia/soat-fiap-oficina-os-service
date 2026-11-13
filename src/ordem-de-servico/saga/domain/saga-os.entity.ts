import { MotivoCancelamento } from '../../domain/value-objects/motivo-cancelamento';
import { StatusOS } from '../../domain/value-objects/status-os.vo';

/**
 * Passos da saga (RFC-0005): cada passo envia um comando (ou aguarda o
 * participante) e so avanca ao receber o evento esperado.
 */
export enum PassoSaga {
  ENFILEIRAR_EXECUCAO = 'ENFILEIRAR_EXECUCAO',
  AGUARDAR_DIAGNOSTICO = 'AGUARDAR_DIAGNOSTICO',
  GERAR_ORCAMENTO = 'GERAR_ORCAMENTO',
  AGUARDAR_APROVACAO = 'AGUARDAR_APROVACAO',
  INICIAR_EXECUCAO = 'INICIAR_EXECUCAO',
  AGUARDAR_FINALIZACAO = 'AGUARDAR_FINALIZACAO',
  /** Servico executado: pede ao Billing a cobranca (`billing.cobrar`). */
  COBRAR = 'COBRAR',
  /** Cobranca criada; aguardando o cliente pagar (pos-execucao, sem rollback). */
  AGUARDAR_PAGAMENTO = 'AGUARDAR_PAGAMENTO',
  CONCLUIDA = 'CONCLUIDA',
}

export enum StatusSaga {
  EM_ANDAMENTO = 'EM_ANDAMENTO',
  COMPENSANDO = 'COMPENSANDO',
  CONCLUIDA = 'CONCLUIDA',
  CANCELADA = 'CANCELADA',
}

/** Comandos que o orquestrador envia (AsyncAPI: filas execucao-comandos / billing-comandos). */
export type TipoComando =
  | 'execucao.enfileirar'
  | 'execucao.iniciar'
  | 'execucao.liberar-reservas'
  | 'billing.gerar-orcamento'
  | 'billing.cobrar'
  | 'billing.cancelar-orcamento';

export interface ComandoSaga {
  type: TipoComando;
  data: Record<string, unknown>;
  /** id do envelope que motivou o comando (ADR-0009). */
  causationId?: string;
}

/** O que o orquestrador deve aplicar na OS depois que a saga aceitou o evento. */
export type TransicaoOS =
  | { tipo: 'iniciarDiagnostico' }
  | { tipo: 'registrarDiagnostico' }
  | { tipo: 'aguardarAprovacao' }
  | { tipo: 'aguardarPagamento' }
  | { tipo: 'iniciarExecucao' }
  | { tipo: 'finalizar' }
  | { tipo: 'cancelar'; motivo: MotivoCancelamento };

/** Evento recebido (dos participantes, do atendente ou do relogio). */
export interface EventoSaga {
  type: string;
  /** id do envelope (ausente para eventos internos). */
  id?: string;
  data: Record<string, any>;
}

export type ResultadoPasso =
  | 'avancou'
  | 'ignorado'
  | 'compensando'
  | 'confirmacao'
  | 'concluida'
  | 'cancelada'
  | 'reprocessada'
  | 'falha-simulada'
  /** Pagamento recusado apos a execucao: a saga continua esperando (sem compensacao). */
  | 'pagamento-pendente'
  /**
   * Comando nao entregue ao participante (tentativas esgotadas ou 4xx sem
   * evento): a saga fica no passo, conta em `oficina_os_sagas_paradas` e
   * `POST /admin/sagas/:numero/reprocessar` reenvia (US-F4-18).
   */
  | 'chamada-falhou';

export interface PassoHistorico {
  em: string;
  passo: PassoSaga;
  evento: string;
  resultado: ResultadoPasso;
  detalhe?: string;
  /** So em `chamada-falhou`: tentativas feitas pelo cliente HTTP antes de desistir. */
  tentativas?: number;
}

/** Falha de entrega de um comando, como o gateway dos participantes devolve. */
export interface FalhaDeChamada {
  erro: string;
  status?: number;
  tentativas?: number;
}

export interface Compensacao {
  comando: TipoComando;
  enviadaEm: string;
  confirmadaEm?: string;
}

export interface ResultadoAplicacao {
  /** false = evento ignorado (duplicado/fora de ordem) — nada a aplicar na OS. */
  aplicado: boolean;
  /** true = evento rejeitado (ex.: cancelamento manual apos a execucao comecar). */
  rejeitado?: boolean;
  motivo?: string;
  transicaoOS?: TransicaoOS;
  comandos: ComandoSaga[];
}

export interface Prazos {
  aprovacaoMs: number;
  pagamentoMs: number;
}

export interface SagaOSProps {
  id?: string;
  numero: string;
  clienteId: string;
  veiculoId: string;
  descricaoProblema: string;
  passo: PassoSaga;
  status: StatusSaga;
  /** Quando entrou no passo atual. */
  passoDesde?: Date;
  historico: PassoHistorico[];
  compensacoes: Compensacao[];
  prazoAprovacao: Date | null;
  prazoPagamento: Date | null;
  /** Demo (US-F4-11): passo em que a saga deve simular a falha do participante. */
  falhaSimulada?: PassoSaga | null;
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const ORDEM: PassoSaga[] = [
  PassoSaga.ENFILEIRAR_EXECUCAO,
  PassoSaga.AGUARDAR_DIAGNOSTICO,
  PassoSaga.GERAR_ORCAMENTO,
  PassoSaga.AGUARDAR_APROVACAO,
  PassoSaga.INICIAR_EXECUCAO,
  PassoSaga.AGUARDAR_FINALIZACAO,
  PassoSaga.COBRAR,
  PassoSaga.AGUARDAR_PAGAMENTO,
  PassoSaga.CONCLUIDA,
];
const indice = (p: PassoSaga) => ORDEM.indexOf(p);
const HISTORICO_MAX = 200;

/** Passo da saga equivalente ao status de uma OS que nasceu antes da saga existir. */
const PASSO_POR_STATUS: Record<StatusOS, PassoSaga> = {
  [StatusOS.RECEBIDA]: PassoSaga.ENFILEIRAR_EXECUCAO,
  [StatusOS.EM_DIAGNOSTICO]: PassoSaga.AGUARDAR_DIAGNOSTICO,
  [StatusOS.AGUARDANDO_APROVACAO]: PassoSaga.AGUARDAR_APROVACAO,
  [StatusOS.EM_EXECUCAO]: PassoSaga.AGUARDAR_FINALIZACAO,
  [StatusOS.AGUARDANDO_PAGAMENTO]: PassoSaga.AGUARDAR_PAGAMENTO,
  [StatusOS.FINALIZADA]: PassoSaga.CONCLUIDA,
  [StatusOS.ENTREGUE]: PassoSaga.CONCLUIDA,
  [StatusOS.CANCELADA]: PassoSaga.CONCLUIDA,
};

/**
 * Maquina de estados PURA da saga da OS (RFC-0005). Nao conhece banco nem
 * broker: recebe um evento e devolve o que aplicar na OS e quais comandos
 * enviar; o orquestrador (application) persiste e publica.
 *
 * Regras:
 * - cada passo so avanca com o evento esperado; outros eventos sao ignorados
 *   com registro no historico (duplicados / fora de ordem);
 * - falha de negocio ANTES da execucao -> COMPENSANDO: comandos de compensacao
 *   em ordem inversa, OS cancelada com o motivo; quando todas as confirmacoes
 *   chegam -> CANCELADA;
 * - a cobranca acontece DEPOIS da execucao (ADR-0012, decisao de 03/11): pagamento
 *   recusado ou em atraso nao compensa nada — a OS fica retida em
 *   AGUARDANDO_PAGAMENTO e a saga continua em AGUARDAR_PAGAMENTO;
 * - timeouts sao eventos internos `saga.timeout`: o de aprovacao compensa, o de
 *   pagamento so registra o atraso (o alerta vem da gauge de sagas paradas).
 */
export class SagaOS {
  readonly id?: string;
  readonly numero: string;
  readonly clienteId: string;
  readonly veiculoId: string;
  readonly descricaoProblema: string;
  private _passo: PassoSaga;
  private _status: StatusSaga;
  private _passoDesde: Date;
  private _historico: PassoHistorico[];
  private _compensacoes: Compensacao[];
  private _prazoAprovacao: Date | null;
  private _prazoPagamento: Date | null;
  private _falhaSimulada: PassoSaga | null;
  private _version: number;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  private _comandosPendentes: ComandoSaga[] = [];

  private constructor(p: SagaOSProps) {
    this.id = p.id;
    this.numero = p.numero;
    this.clienteId = p.clienteId;
    this.veiculoId = p.veiculoId;
    this.descricaoProblema = p.descricaoProblema;
    this._passo = p.passo;
    this._status = p.status;
    this._passoDesde = p.passoDesde ?? p.createdAt ?? new Date();
    this._historico = [...p.historico];
    this._compensacoes = [...p.compensacoes];
    this._prazoAprovacao = p.prazoAprovacao;
    this._prazoPagamento = p.prazoPagamento;
    this._falhaSimulada = p.falhaSimulada ?? null;
    this._version = p.version;
    this.createdAt = p.createdAt;
    this.updatedAt = p.updatedAt;
  }

  /** Abertura da OS: primeiro passo = enfileirar na Execucao. */
  static iniciar(
    dados: { numero: string; clienteId: string; veiculoId: string; descricaoProblema: string; falhaSimulada?: PassoSaga | null },
    agora: Date = new Date(),
  ): SagaOS {
    const { falhaSimulada, ...resto } = dados;
    const saga = new SagaOS({
      ...resto,
      falhaSimulada: falhaSimulada ?? null,
      passo: PassoSaga.ENFILEIRAR_EXECUCAO,
      status: StatusSaga.EM_ANDAMENTO,
      passoDesde: agora,
      historico: [],
      compensacoes: [],
      prazoAprovacao: null,
      prazoPagamento: null,
      version: 0,
    });
    saga.registrar(agora, 'os.aberta', 'avancou', 'saga iniciada');
    saga.enviar({
      type: 'execucao.enfileirar',
      data: { numeroOS: dados.numero, veiculoId: dados.veiculoId, descricaoProblema: dados.descricaoProblema },
    });
    return saga;
  }

  /**
   * OS anterior a saga (ou saga perdida): adota o passo equivalente ao status
   * atual. EM_DIAGNOSTICO com diagnostico ja gravado = aguardando o orcamento.
   * So em RECEBIDA reenvia `execucao.enfileirar` (nenhum comando saiu ainda).
   */
  static adotar(
    dados: { numero: string; clienteId: string; veiculoId: string; descricaoProblema: string; statusOS: StatusOS; temDiagnostico?: boolean },
    agora: Date = new Date(),
  ): SagaOS {
    const passo =
      dados.statusOS === StatusOS.EM_DIAGNOSTICO && dados.temDiagnostico ? PassoSaga.GERAR_ORCAMENTO : PASSO_POR_STATUS[dados.statusOS];
    const status =
      dados.statusOS === StatusOS.CANCELADA
        ? StatusSaga.CANCELADA
        : passo === PassoSaga.CONCLUIDA
          ? StatusSaga.CONCLUIDA
          : StatusSaga.EM_ANDAMENTO;
    const saga = new SagaOS({
      numero: dados.numero,
      clienteId: dados.clienteId,
      veiculoId: dados.veiculoId,
      descricaoProblema: dados.descricaoProblema,
      passo,
      status,
      passoDesde: agora,
      historico: [],
      compensacoes: [],
      prazoAprovacao: null,
      prazoPagamento: null,
      version: 0,
    });
    saga.registrar(agora, 'saga.adotada', 'avancou', `adotada a partir do status ${dados.statusOS}`);
    if (dados.statusOS === StatusOS.RECEBIDA) {
      saga.enviar({
        type: 'execucao.enfileirar',
        data: { numeroOS: dados.numero, veiculoId: dados.veiculoId, descricaoProblema: dados.descricaoProblema },
      });
    }
    return saga;
  }

  static reconstitute(p: SagaOSProps): SagaOS {
    return new SagaOS(p);
  }

  // ─── leitura ────────────────────────────────────────────────────────────────

  get passo(): PassoSaga {
    return this._passo;
  }
  get status(): StatusSaga {
    return this._status;
  }
  get historico(): readonly PassoHistorico[] {
    return this._historico;
  }
  get compensacoes(): readonly Compensacao[] {
    return this._compensacoes;
  }
  get passoDesde(): Date {
    return this._passoDesde;
  }
  get prazoAprovacao(): Date | null {
    return this._prazoAprovacao;
  }
  get falhaSimulada(): PassoSaga | null {
    return this._falhaSimulada;
  }
  get prazoPagamento(): Date | null {
    return this._prazoPagamento;
  }
  get version(): number {
    return this._version;
  }
  get comandosPendentes(): readonly ComandoSaga[] {
    return this._comandosPendentes;
  }
  get encerrada(): boolean {
    return this._status === StatusSaga.CONCLUIDA || this._status === StatusSaga.CANCELADA;
  }

  /** Entrega os comandos a publicar e esvazia a lista (o repositorio consome na transacao). */
  consumirComandos(): ComandoSaga[] {
    const c = this._comandosPendentes;
    this._comandosPendentes = [];
    return c;
  }

  // ─── maquina de estados ─────────────────────────────────────────────────────

  /**
   * Aplica um evento. Nunca lanca: eventos inesperados viram `aplicado: false`
   * (registrados no historico); so o cancelamento manual pode ser `rejeitado`.
   */
  aplicar(evento: EventoSaga, agora: Date = new Date(), prazos: Prazos = PRAZOS_DEFAULT): ResultadoAplicacao {
    if (this._status === StatusSaga.COMPENSANDO) return this.aplicarEmCompensacao(evento, agora);
    if (this.encerrada) return this.ignorar(evento, agora, `saga ${this._status}`);

    switch (evento.type) {
      case 'execucao.enfileirada':
        return this.esperado(evento, PassoSaga.ENFILEIRAR_EXECUCAO, agora, () => {
          this.avancar(PassoSaga.AGUARDAR_DIAGNOSTICO, agora, evento);
          return { transicaoOS: { tipo: 'iniciarDiagnostico' } };
        });
      case 'execucao.recusada':
        if (this._passo === PassoSaga.ENFILEIRAR_EXECUCAO) {
          return this.compensar(evento, agora, MotivoCancelamento.EXECUCAO_RECUSADA, []);
        }
        if (this._passo === PassoSaga.INICIAR_EXECUCAO) {
          // Orcamento aprovado mas nada pago nem executado: cancela o orcamento e libera reservas (ordem inversa)
          return this.compensar(evento, agora, MotivoCancelamento.FALHA_INICIO_EXECUCAO, [
            'billing.cancelar-orcamento',
            'execucao.liberar-reservas',
          ]);
        }
        return this.ignorar(evento, agora, `nao esperado no passo ${this._passo}`);
      case 'execucao.diagnostico-concluido':
        if (!Array.isArray(evento.data.itens) || evento.data.itens.length === 0) {
          // Contrato exige minItems 1; sem itens nao ha orcamento a gerar — espera um diagnostico valido.
          return this.ignorar(evento, agora, 'diagnostico sem itens (contrato exige ao menos 1)');
        }
        return this.esperado(evento, PassoSaga.AGUARDAR_DIAGNOSTICO, agora, () => {
          this.avancar(PassoSaga.GERAR_ORCAMENTO, agora, evento);
          this.enviar({
            type: 'billing.gerar-orcamento',
            data: { numeroOS: this.numero, clienteId: this.clienteId, itens: evento.data.itens },
            causationId: evento.id,
          });
          return { transicaoOS: { tipo: 'registrarDiagnostico' } };
        });
      case 'billing.orcamento-gerado':
        return this.esperado(evento, PassoSaga.GERAR_ORCAMENTO, agora, () => {
          this.avancar(PassoSaga.AGUARDAR_APROVACAO, agora, evento);
          this._prazoAprovacao = new Date(agora.getTime() + prazos.aprovacaoMs);
          return { transicaoOS: { tipo: 'aguardarAprovacao' } };
        });
      case 'billing.orcamento-aprovado':
        // Sem cobranca aqui: a OS continua AGUARDANDO_APROVACAO ate a Execucao confirmar o inicio.
        return this.esperado(evento, PassoSaga.AGUARDAR_APROVACAO, agora, () => {
          this.avancar(PassoSaga.INICIAR_EXECUCAO, agora, evento);
          this._prazoAprovacao = null;
          this.enviar({ type: 'execucao.iniciar', data: { numeroOS: this.numero }, causationId: evento.id });
          return {};
        });
      case 'billing.orcamento-rejeitado':
        return this.esperado(evento, PassoSaga.AGUARDAR_APROVACAO, agora, () =>
          this.compensar(evento, agora, MotivoCancelamento.ORCAMENTO_REJEITADO, ['execucao.liberar-reservas']),
        );
      case 'execucao.iniciada':
        return this.esperado(evento, PassoSaga.INICIAR_EXECUCAO, agora, () => {
          this.avancar(PassoSaga.AGUARDAR_FINALIZACAO, agora, evento);
          return { transicaoOS: { tipo: 'iniciarExecucao' } };
        });
      case 'execucao.finalizada':
        // Servico executado: a OS fica AGUARDANDO_PAGAMENTO e o Billing cria a cobranca.
        return this.esperado(evento, PassoSaga.AGUARDAR_FINALIZACAO, agora, () => {
          this.avancar(PassoSaga.COBRAR, agora, evento);
          this.enviar({ type: 'billing.cobrar', data: { numeroOS: this.numero }, causationId: evento.id });
          return { transicaoOS: { tipo: 'aguardarPagamento' } };
        });
      case 'billing.cobranca-criada':
        if (this._passo === PassoSaga.AGUARDAR_PAGAMENTO) {
          // Nova cobranca (reprocessamento apos recusa/atraso): so renova o prazo e registra.
          this._prazoPagamento = new Date(agora.getTime() + prazos.pagamentoMs);
          this.registrar(agora, evento.type, 'avancou', `nova cobranca registrada (orderId=${evento.data.orderId ?? '?'})`);
          return { aplicado: true, comandos: [] };
        }
        return this.esperado(evento, PassoSaga.COBRAR, agora, () => {
          this.avancar(PassoSaga.AGUARDAR_PAGAMENTO, agora, evento);
          // Prazo so para metrica/alerta: vencido, registra o atraso — nao cancela (servico ja executado).
          this._prazoPagamento = new Date(agora.getTime() + prazos.pagamentoMs);
          return {};
        });
      case 'billing.pagamento-aprovado':
        return this.esperado(evento, PassoSaga.AGUARDAR_PAGAMENTO, agora, () => {
          this._passo = PassoSaga.CONCLUIDA;
          this._passoDesde = agora;
          this._status = StatusSaga.CONCLUIDA;
          this._prazoPagamento = null;
          this.registrar(agora, evento.type, 'concluida');
          return { transicaoOS: { tipo: 'finalizar' } };
        });
      case 'billing.pagamento-recusado':
        // Servico ja executado: nao ha rollback. A OS fica retida em AGUARDANDO_PAGAMENTO
        // (reprocessar reenvia `billing.cobrar`; a gauge de sagas paradas cobre o alerta).
        return this.esperado(evento, PassoSaga.AGUARDAR_PAGAMENTO, agora, () => {
          this.registrar(agora, evento.type, 'pagamento-pendente', `pagamento recusado: ${evento.data.motivo ?? 'sem motivo'}`);
          return { comandos: [] };
        });
      case 'saga.timeout':
        return this.timeout(evento, agora);
      case 'os.cancelamento-manual':
        return this.cancelamentoManual(evento, agora);
      case 'billing.orcamento-cancelado':
      case 'execucao.reservas-liberadas':
        return this.ignorar(evento, agora, 'confirmacao de compensacao sem compensacao em curso');
      default:
        return this.ignorar(evento, agora, 'evento desconhecido');
    }
  }

  /**
   * Injecao de falhas para a demo (US-F4-11): se a saga foi aberta com
   * `falhaSimulada` = passo atual e chega o evento de sucesso desse passo, o
   * evento e trocado pelo de falha correspondente (uma unica vez). Fora disso,
   * devolve o evento intacto.
   */
  simularFalha(evento: EventoSaga, agora: Date = new Date()): EventoSaga {
    if (!this._falhaSimulada || this._falhaSimulada !== this._passo) return evento;
    const substituto = FALHA_SIMULADA[this._passo]?.[evento.type];
    if (!substituto) return evento;
    this._falhaSimulada = null;
    this.registrar(agora, evento.type, 'falha-simulada', `demo: ${evento.type} tratado como ${substituto}`);
    return { ...evento, type: substituto, data: { ...evento.data, motivo: `falha simulada no passo ${this._passo}` } };
  }

  /**
   * Retomada manual (ADMIN): reenvia o comando do passo atual ou as compensacoes
   * ainda nao confirmadas. Passos que esperam cliente/participante nao tem
   * comando a reenviar — excecao: AGUARDAR_PAGAMENTO reenvia `billing.cobrar`
   * (nova cobranca para pagamento recusado/em atraso). `itens` (snapshot da OS)
   * so e usado em GERAR_ORCAMENTO.
   */
  reprocessar(dados: { itens?: ItemContrato[] }, agora: Date = new Date()): ComandoSaga[] {
    const antes = this._comandosPendentes.length;
    if (this._status === StatusSaga.COMPENSANDO) {
      for (const c of this._compensacoes) {
        if (c.confirmadaEm) continue;
        this.enviar({
          type: c.comando,
          data: c.comando === 'billing.cancelar-orcamento' ? { numeroOS: this.numero, motivo: MotivoCancelamento.OPERADOR } : { numeroOS: this.numero },
        });
        c.enviadaEm = agora.toISOString();
      }
    } else if (this._status === StatusSaga.EM_ANDAMENTO) {
      switch (this._passo) {
        case PassoSaga.ENFILEIRAR_EXECUCAO:
          this.enviar({ type: 'execucao.enfileirar', data: { numeroOS: this.numero, veiculoId: this.veiculoId, descricaoProblema: this.descricaoProblema } });
          break;
        case PassoSaga.GERAR_ORCAMENTO:
          if (dados.itens && dados.itens.length > 0) {
            this.enviar({ type: 'billing.gerar-orcamento', data: { numeroOS: this.numero, clienteId: this.clienteId, itens: dados.itens } });
          }
          break;
        case PassoSaga.INICIAR_EXECUCAO:
          this.enviar({ type: 'execucao.iniciar', data: { numeroOS: this.numero } });
          break;
        case PassoSaga.COBRAR:
        case PassoSaga.AGUARDAR_PAGAMENTO:
          // Nova cobranca (pagamento recusado/em atraso): o Billing cria outra order.
          this.enviar({ type: 'billing.cobrar', data: { numeroOS: this.numero } });
          break;
        default:
          break;
      }
    }
    const reenviados = this._comandosPendentes.slice(antes);
    this.registrar(
      agora,
      'saga.reprocessar',
      'reprocessada',
      reenviados.length ? `reenviado: ${reenviados.map((c) => c.type).join(', ')}` : 'nada a reenviar neste passo',
    );
    return reenviados;
  }

  /**
   * Registra que um comando decidido pela saga NAO chegou ao participante
   * (tentativas esgotadas / 4xx sem evento). Nao muda passo nem status: a saga
   * fica parada onde estava ate o reprocessamento; o historico guarda o comando,
   * as tentativas e o motivo (US-F4-18).
   */
  registrarChamadaFalhou(comando: TipoComando, falha: FalhaDeChamada, agora: Date = new Date()): void {
    const status = falha.status !== undefined ? `HTTP ${falha.status}` : 'sem resposta';
    const tentativas = falha.tentativas ?? 1;
    this.registrar(agora, comando, 'chamada-falhou', `${status} apos ${tentativas} tentativa(s): ${falha.erro}`, tentativas);
  }

  /** `true` quando a ultima entrada do historico e uma chamada nao entregue (saga parada ate reprocessar). */
  get aguardandoReprocessamento(): boolean {
    return !this.encerrada && this._historico[this._historico.length - 1]?.resultado === 'chamada-falhou';
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  private esperado(
    evento: EventoSaga,
    passo: PassoSaga,
    agora: Date,
    acao: () => Partial<ResultadoAplicacao>,
  ): ResultadoAplicacao {
    if (this._passo !== passo) {
      const motivo =
        indice(this._passo) > indice(passo) ? 'duplicado (passo ja concluido)' : `fora de ordem (esperado no passo ${passo})`;
      return this.ignorar(evento, agora, motivo);
    }
    const parcial = acao();
    return { aplicado: true, comandos: this._comandosPendentes.slice(), ...parcial };
  }

  private avancar(proximo: PassoSaga, agora: Date, evento: EventoSaga): void {
    this.registrar(agora, evento.type, 'avancou', `${this._passo} -> ${proximo}`);
    this._passo = proximo;
    this._passoDesde = agora;
  }

  private ignorar(evento: EventoSaga, agora: Date, motivo: string): ResultadoAplicacao {
    this.registrar(agora, evento.type, 'ignorado', motivo);
    return { aplicado: false, motivo, comandos: [] };
  }

  private enviar(comando: ComandoSaga): void {
    this._comandosPendentes.push(comando);
  }

  private registrar(agora: Date, evento: string, resultado: ResultadoPasso, detalhe?: string, tentativas?: number): void {
    const entrada: PassoHistorico = { em: agora.toISOString(), passo: this._passo, evento, resultado, detalhe };
    if (tentativas !== undefined) entrada.tentativas = tentativas;
    this._historico.push(entrada);
    // Teto do JSON: mantem as entradas mais recentes (duplicados/fora de ordem podem se repetir).
    if (this._historico.length > HISTORICO_MAX) this._historico.splice(0, this._historico.length - HISTORICO_MAX);
  }

  /** Falha de negocio: comandos de compensacao (ordem inversa) + OS cancelada. */
  private compensar(
    evento: EventoSaga,
    agora: Date,
    motivo: MotivoCancelamento,
    comandos: Array<'billing.cancelar-orcamento' | 'execucao.liberar-reservas'>,
  ): ResultadoAplicacao {
    this._prazoAprovacao = null;
    this._prazoPagamento = null;
    for (const type of comandos) {
      this.enviar({
        type,
        data: type === 'billing.cancelar-orcamento' ? { numeroOS: this.numero, motivo } : { numeroOS: this.numero },
        causationId: evento.id,
      });
      this._compensacoes.push({ comando: type, enviadaEm: agora.toISOString() });
    }
    if (comandos.length === 0) {
      this._status = StatusSaga.CANCELADA;
      this.registrar(agora, evento.type, 'cancelada', motivo);
    } else {
      this._status = StatusSaga.COMPENSANDO;
      this.registrar(agora, evento.type, 'compensando', `${motivo}: ${comandos.join(', ')}`);
    }
    return { aplicado: true, transicaoOS: { tipo: 'cancelar', motivo }, comandos: this._comandosPendentes.slice() };
  }

  /** Em COMPENSANDO so interessam as confirmacoes; o resto e ignorado. */
  private aplicarEmCompensacao(evento: EventoSaga, agora: Date): ResultadoAplicacao {
    const comando: TipoComando | null =
      evento.type === 'billing.orcamento-cancelado'
        ? 'billing.cancelar-orcamento'
        : evento.type === 'execucao.reservas-liberadas'
          ? 'execucao.liberar-reservas'
          : null;
    if (!comando) return this.ignorar(evento, agora, 'saga em compensacao');
    const pendente = this._compensacoes.find((c) => c.comando === comando && !c.confirmadaEm);
    if (!pendente) return this.ignorar(evento, agora, 'compensacao ja confirmada');
    pendente.confirmadaEm = agora.toISOString();
    const restantes = this._compensacoes.filter((c) => !c.confirmadaEm).length;
    if (restantes === 0) {
      this._status = StatusSaga.CANCELADA;
      this.registrar(agora, evento.type, 'cancelada', 'todas as compensacoes confirmadas');
    } else {
      this.registrar(agora, evento.type, 'confirmacao', `${restantes} compensacao(oes) pendente(s)`);
    }
    return { aplicado: true, comandos: [] };
  }

  private timeout(evento: EventoSaga, agora: Date): ResultadoAplicacao {
    if (this._passo === PassoSaga.AGUARDAR_APROVACAO && this._prazoAprovacao && this._prazoAprovacao <= agora) {
      return this.compensar(evento, agora, MotivoCancelamento.TIMEOUT_APROVACAO, [
        'billing.cancelar-orcamento',
        'execucao.liberar-reservas',
      ]);
    }
    if (this._passo === PassoSaga.AGUARDAR_PAGAMENTO && this._prazoPagamento && this._prazoPagamento <= agora) {
      // Pos-execucao: nao cancela (TIMEOUT_PAGAMENTO ficou reservado). Registra uma vez e
      // limpa o prazo para o relogio nao reencontrar a saga; a gauge de sagas paradas alerta.
      this._prazoPagamento = null;
      return this.ignorar(evento, agora, 'pagamento em atraso (OS retida em AGUARDANDO_PAGAMENTO, sem compensacao)');
    }
    // Prazo obsoleto num passo que nao tem timeout: limpa para o relogio parar de reencontrar esta saga.
    if (this._passo !== PassoSaga.AGUARDAR_APROVACAO) this._prazoAprovacao = null;
    if (this._passo !== PassoSaga.AGUARDAR_PAGAMENTO) this._prazoPagamento = null;
    return this.ignorar(evento, agora, 'sem prazo vencido neste passo');
  }

  /**
   * Atendente cancela: compensa conforme o passo; depois de a execucao comecar
   * (AGUARDAR_FINALIZACAO em diante, inclusive aguardando o pagamento) nao da mais. `execucao.enfileirar` ja saiu na abertura, entao desde o
   * primeiro passo a Execucao recebe `execucao.liberar-reservas` (= tirar da
   * fila/abortar diagnostico e devolver reservas, ver AsyncAPI). Como comandos
   * da mesma OS vao para a mesma fila FIFO com o mesmo MessageGroupId, o
   * cancelamento nunca ultrapassa o comando que o precede.
   */
  private cancelamentoManual(evento: EventoSaga, agora: Date): ResultadoAplicacao {
    const motivo = (evento.data.motivo as MotivoCancelamento) ?? MotivoCancelamento.OPERADOR;
    const porPasso: Partial<Record<PassoSaga, Array<'billing.cancelar-orcamento' | 'execucao.liberar-reservas'>>> = {
      [PassoSaga.ENFILEIRAR_EXECUCAO]: ['execucao.liberar-reservas'],
      [PassoSaga.AGUARDAR_DIAGNOSTICO]: ['execucao.liberar-reservas'],
      [PassoSaga.GERAR_ORCAMENTO]: ['billing.cancelar-orcamento', 'execucao.liberar-reservas'],
      [PassoSaga.AGUARDAR_APROVACAO]: ['billing.cancelar-orcamento', 'execucao.liberar-reservas'],
      [PassoSaga.INICIAR_EXECUCAO]: ['billing.cancelar-orcamento', 'execucao.liberar-reservas'],
    };
    const comandos = porPasso[this._passo];
    if (!comandos) {
      this.registrar(agora, evento.type, 'ignorado', `cancelamento nao permitido no passo ${this._passo}`);
      return { aplicado: false, rejeitado: true, motivo: `OS em ${this._passo} nao pode ser cancelada`, comandos: [] };
    }
    return this.compensar(evento, agora, motivo, comandos);
  }
}

/** Item no formato do AsyncAPI (`Item`), usado ao reenviar `billing.gerar-orcamento`. */
export interface ItemContrato {
  tipo: 'SERVICO' | 'PRODUTO';
  referenciaId: string;
  nome: string;
  quantidade: number;
  precoUnitario: string;
  servicoId?: string;
}

/** Evento de sucesso -> evento de falha, por passo (injecao de falhas da demo). */
const FALHA_SIMULADA: Partial<Record<PassoSaga, Record<string, string>>> = {
  [PassoSaga.ENFILEIRAR_EXECUCAO]: { 'execucao.enfileirada': 'execucao.recusada' },
  [PassoSaga.AGUARDAR_APROVACAO]: { 'billing.orcamento-aprovado': 'billing.orcamento-rejeitado' },
  [PassoSaga.INICIAR_EXECUCAO]: { 'execucao.iniciada': 'execucao.recusada' },
  // Pos-execucao: demonstra o pagamento pendente (sem compensacao), nao um cancelamento.
  [PassoSaga.AGUARDAR_PAGAMENTO]: { 'billing.pagamento-aprovado': 'billing.pagamento-recusado' },
};
/** Passos em que a demo pode simular falha. */
export const PASSOS_COM_FALHA_SIMULAVEL = Object.keys(FALHA_SIMULADA) as PassoSaga[];

export const PRAZOS_DEFAULT: Prazos = {
  aprovacaoMs: 3 * 24 * 60 * 60 * 1000,
  pagamentoMs: 24 * 60 * 60 * 1000,
};
