import { StatusOS, StatusOSVO } from './value-objects/status-os.vo';
import { ItemServicoOS } from './value-objects/item-servico-os.vo';
import { MotivoCancelamento } from './value-objects/motivo-cancelamento';
import { InvalidDescriptionError } from './errors/invalid-description.error';
import { InvalidStatusTransitionError } from './errors/invalid-status-transition.error';
import { ServicoAlreadyAddedError } from './errors/servico-already-added.error';

export interface CreateOrdemDeServicoProps {
  clienteId: string;
  veiculoId: string;
  descricaoInicial: string;
}

export interface ReconstituteOrdemDeServicoProps {
  id: string;
  numero: string;
  clienteId: string;
  veiculoId: string;
  mecanicoId: string | null;
  descricaoInicial: string;
  diagnostico: string | null;
  status: StatusOS;
  motivoCancelamento: MotivoCancelamento | null;
  createdAt: Date;
  updatedAt: Date;
  version?: number;
  itensServico?: ItemServicoOS[];
}

export interface DiagnosticoProps {
  diagnostico: string;
  mecanicoId: string;
  itens: ItemServicoOS[];
}

/**
 * Status a partir dos quais a OS ainda pode ser cancelada (compensacao da saga).
 * Depois que a execucao comeca nao ha cancelamento — inclusive em
 * AGUARDANDO_PAGAMENTO, que agora vem DEPOIS do servico executado (ADR-0012).
 */
const CANCELAVEIS: ReadonlySet<StatusOS> = new Set([
  StatusOS.RECEBIDA,
  StatusOS.EM_DIAGNOSTICO,
  StatusOS.AGUARDANDO_APROVACAO,
]);

/**
 * Agregado raiz do Atendimento (OS Service, Fase 4). Dona do ciclo de vida da
 * OS; as transicoes sao disparadas pelas respostas/callbacks HTTP dos demais
 * servicos via o orquestrador da saga (RFC-0005/RFC-0008) — por isso os metodos
 * sao nomeados pelo FATO que registram, nao pela acao do usuario. Itens de servico/peca sao SNAPSHOT
 * do diagnostico do Execucao Service (precos congelados, RFC-0004).
 */
export class OrdemDeServico {
  readonly id?: string;
  private _numero: string;
  private _clienteId: string;
  private _veiculoId: string;
  private _mecanicoId: string | null;
  private _descricaoInicial: string;
  private _diagnostico: string | null;
  private _status: StatusOSVO;
  private _motivoCancelamento: MotivoCancelamento | null;
  private _itensServico: ItemServicoOS[];
  private _createdAt?: Date;
  private _updatedAt?: Date;
  /** Lock otimista (0 em OS nova; o repositorio exige a versao lida ao gravar). */
  private _version: number;

  private constructor(
    props: {
      numero: string;
      clienteId: string;
      veiculoId: string;
      mecanicoId: string | null;
      descricaoInicial: string;
      diagnostico: string | null;
      status: StatusOSVO;
      motivoCancelamento: MotivoCancelamento | null;
      itensServico?: ItemServicoOS[];
      createdAt?: Date;
      updatedAt?: Date;
      version?: number;
    },
    id?: string,
  ) {
    this.id = id;
    this._numero = props.numero;
    this._clienteId = props.clienteId;
    this._veiculoId = props.veiculoId;
    this._mecanicoId = props.mecanicoId;
    this._descricaoInicial = props.descricaoInicial;
    this._diagnostico = props.diagnostico;
    this._status = props.status;
    this._motivoCancelamento = props.motivoCancelamento;
    this._itensServico = props.itensServico ?? [];
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._version = props.version ?? 0;
  }

  static create(props: CreateOrdemDeServicoProps): OrdemDeServico {
    OrdemDeServico.validateDescricaoInicial(props.descricaoInicial);
    return new OrdemDeServico({
      numero: OrdemDeServico.gerarNumeroOS(),
      clienteId: props.clienteId,
      veiculoId: props.veiculoId,
      mecanicoId: null,
      descricaoInicial: props.descricaoInicial,
      diagnostico: null,
      status: StatusOSVO.create(StatusOS.RECEBIDA),
      motivoCancelamento: null,
    });
  }

  static reconstitute(props: ReconstituteOrdemDeServicoProps): OrdemDeServico {
    return new OrdemDeServico(
      {
        numero: props.numero,
        clienteId: props.clienteId,
        veiculoId: props.veiculoId,
        mecanicoId: props.mecanicoId,
        descricaoInicial: props.descricaoInicial,
        diagnostico: props.diagnostico,
        status: StatusOSVO.create(props.status),
        motivoCancelamento: props.motivoCancelamento,
        itensServico: props.itensServico,
        createdAt: props.createdAt,
        updatedAt: props.updatedAt,
        version: props.version,
      },
      props.id,
    );
  }

  private static validateDescricaoInicial(descricao: string): void {
    if (!descricao || descricao.trim().length < 5) {
      throw new InvalidDescriptionError('Descricao inicial deve ter no minimo 5 caracteres');
    }
    if (descricao.length > 500) {
      throw new InvalidDescriptionError('Descricao inicial nao pode exceder 500 caracteres');
    }
  }

  private static gerarNumeroOS(): string {
    const ano = new Date().getFullYear();
    const timestamp = Date.now().toString().slice(-10);
    const random = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0');
    return `OS-${ano}-${timestamp}-${random}`;
  }

  // ─── transicoes (um metodo por fato do ciclo de vida) ──────────────────────

  private exigirStatus(esperado: StatusOS, alvo: StatusOS | string): void {
    if (!this._status.equals(StatusOSVO.create(esperado))) {
      throw new InvalidStatusTransitionError(this._status.toString(), String(alvo));
    }
  }

  /** `execucao.enfileirada`: a OS entrou na fila da oficina e esta em diagnostico. */
  iniciarDiagnostico(): void {
    this.exigirStatus(StatusOS.RECEBIDA, StatusOS.EM_DIAGNOSTICO);
    this._status = StatusOSVO.create(StatusOS.EM_DIAGNOSTICO);
  }

  /** `execucao.diagnostico-concluido`: snapshot dos itens com precos congelados. */
  registrarDiagnostico(props: DiagnosticoProps): void {
    if (!props.diagnostico || props.diagnostico.trim().length < 5) {
      throw new InvalidDescriptionError('Diagnostico deve ter no minimo 5 caracteres');
    }
    if (props.diagnostico.length > 1000) {
      throw new InvalidDescriptionError('Diagnostico nao pode exceder 1000 caracteres');
    }
    this.exigirStatus(StatusOS.EM_DIAGNOSTICO, 'registrar diagnostico');
    const vistos = new Set<string>();
    for (const item of props.itens) {
      if (vistos.has(item.servicoId)) throw new ServicoAlreadyAddedError(item.servicoId);
      vistos.add(item.servicoId);
    }
    this._diagnostico = props.diagnostico;
    this._mecanicoId = props.mecanicoId;
    this._itensServico = [...props.itens];
  }

  /** `billing.orcamento-gerado`: o cliente precisa aprovar. */
  aguardarAprovacao(): void {
    this.exigirStatus(StatusOS.EM_DIAGNOSTICO, StatusOS.AGUARDANDO_APROVACAO);
    this._status = StatusOSVO.create(StatusOS.AGUARDANDO_APROVACAO);
  }

  /** `execucao.iniciada`: orcamento aprovado e estoque baixado; oficina executando. */
  iniciarExecucao(): void {
    this.exigirStatus(StatusOS.AGUARDANDO_APROVACAO, StatusOS.EM_EXECUCAO);
    this._status = StatusOSVO.create(StatusOS.EM_EXECUCAO);
  }

  /** `execucao.finalizada`: servico executado; a cobranca e criada e aguarda o pagamento (ADR-0012). */
  aguardarPagamento(): void {
    this.exigirStatus(StatusOS.EM_EXECUCAO, StatusOS.AGUARDANDO_PAGAMENTO);
    this._status = StatusOSVO.create(StatusOS.AGUARDANDO_PAGAMENTO);
  }

  /** `billing.pagamento-aprovado`: pago; veiculo pronto para retirada (notificacao in-process via OsFinalizadaEvent). */
  finalizar(): void {
    this.exigirStatus(StatusOS.AGUARDANDO_PAGAMENTO, StatusOS.FINALIZADA);
    this._status = StatusOSVO.create(StatusOS.FINALIZADA);
  }

  /** Acao do atendente: veiculo entregue (so depois de pago = FINALIZADA), OS encerrada. */
  entregar(): void {
    this.exigirStatus(StatusOS.FINALIZADA, StatusOS.ENTREGUE);
    this._status = StatusOSVO.create(StatusOS.ENTREGUE);
  }

  /** Compensacao da saga ou cancelamento manual — so antes da execucao comecar. */
  cancelar(motivo: MotivoCancelamento): void {
    if (!CANCELAVEIS.has(this._status.valor)) {
      throw new InvalidStatusTransitionError(this._status.toString(), StatusOS.CANCELADA);
    }
    this._status = StatusOSVO.create(StatusOS.CANCELADA);
    this._motivoCancelamento = motivo;
  }

  podeSerCancelada(): boolean {
    return CANCELAVEIS.has(this._status.valor);
  }

  // ─── leitura ────────────────────────────────────────────────────────────────

  /** Versao lida do banco (lock otimista). */
  get version(): number {
    return this._version;
  }

  get numero(): string {
    return this._numero;
  }
  get clienteId(): string {
    return this._clienteId;
  }
  get veiculoId(): string {
    return this._veiculoId;
  }
  /** Mecanico responsavel (id de usuario), conhecido a partir do diagnostico. */
  get mecanicoId(): string | null {
    return this._mecanicoId;
  }
  get descricaoInicial(): string {
    return this._descricaoInicial;
  }
  get diagnostico(): string | null {
    return this._diagnostico;
  }
  get status(): StatusOS {
    return this._status.valor;
  }
  get motivoCancelamento(): MotivoCancelamento | null {
    return this._motivoCancelamento;
  }
  get itensServico(): ReadonlyArray<ItemServicoOS> {
    return this._itensServico;
  }
  valorTotalServicos(): number {
    return this._itensServico.reduce((sum, i) => sum + i.subtotalServico(), 0);
  }
  valorTotalProdutos(): number {
    return this._itensServico.reduce((sum, i) => sum + i.subtotalProdutos(), 0);
  }
  valorTotal(): number {
    return this.valorTotalServicos() + this.valorTotalProdutos();
  }
  get createdAt(): Date | undefined {
    return this._createdAt;
  }
  get updatedAt(): Date | undefined {
    return this._updatedAt;
  }
}
