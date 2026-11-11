import { CanalNotificacao } from './value-objects/canal-notificacao.vo';
import { StatusNotificacao } from './value-objects/status-notificacao.vo';
import { TipoNotificacao } from './value-objects/tipo-notificacao.vo';

export interface CreateNotificacaoProps {
  clienteId: string;
  ordemDeServicoId?: string | null;
  /** Numero da OS (US-F4-12). */
  numeroOS?: string | null;
  /** Id do fato que originou a notificacao — chave de idempotencia com tipo + canal. */
  eventoId?: string | null;
  /** Link de pagamento (`billing.cobranca-criada`). */
  linkPagamento?: string | null;
  tipo: TipoNotificacao;
  canal: CanalNotificacao;
  destinatario: string;
  assunto: string;
  mensagem: string;
}

export interface ReconstituteNotificacaoProps {
  id: string;
  clienteId: string;
  ordemDeServicoId: string | null;
  numeroOS?: string | null;
  eventoId?: string | null;
  linkPagamento?: string | null;
  tipo: TipoNotificacao;
  canal: CanalNotificacao;
  destinatario: string;
  assunto: string;
  mensagem: string;
  status: StatusNotificacao;
  erro: string | null;
  enviadaEm: Date | null;
  createdAt: Date;
}

export class Notificacao {
  readonly id?: string;
  private readonly _clienteId: string;
  private readonly _ordemDeServicoId: string | null;
  private readonly _numeroOS: string | null;
  private readonly _eventoId: string | null;
  private readonly _linkPagamento: string | null;
  private readonly _tipo: TipoNotificacao;
  private readonly _canal: CanalNotificacao;
  private readonly _destinatario: string;
  private readonly _assunto: string;
  private readonly _mensagem: string;
  private _status: StatusNotificacao;
  private _erro: string | null;
  private _enviadaEm: Date | null;
  private readonly _createdAt?: Date;

  private constructor(
    props: {
      clienteId: string;
      ordemDeServicoId: string | null;
      numeroOS: string | null;
      eventoId: string | null;
      linkPagamento: string | null;
      tipo: TipoNotificacao;
      canal: CanalNotificacao;
      destinatario: string;
      assunto: string;
      mensagem: string;
      status: StatusNotificacao;
      erro: string | null;
      enviadaEm: Date | null;
      createdAt?: Date;
    },
    id?: string,
  ) {
    this.id = id;
    this._clienteId = props.clienteId;
    this._ordemDeServicoId = props.ordemDeServicoId;
    this._numeroOS = props.numeroOS;
    this._eventoId = props.eventoId;
    this._linkPagamento = props.linkPagamento;
    this._tipo = props.tipo;
    this._canal = props.canal;
    this._destinatario = props.destinatario;
    this._assunto = props.assunto;
    this._mensagem = props.mensagem;
    this._status = props.status;
    this._erro = props.erro;
    this._enviadaEm = props.enviadaEm;
    this._createdAt = props.createdAt;
  }

  static create(props: CreateNotificacaoProps): Notificacao {
    return new Notificacao({
      clienteId: props.clienteId,
      ordemDeServicoId: props.ordemDeServicoId ?? null,
      numeroOS: props.numeroOS ?? null,
      eventoId: props.eventoId ?? null,
      linkPagamento: props.linkPagamento ?? null,
      tipo: props.tipo,
      canal: props.canal,
      destinatario: props.destinatario,
      assunto: props.assunto,
      mensagem: props.mensagem,
      status: StatusNotificacao.PENDENTE,
      erro: null,
      enviadaEm: null,
    });
  }

  static reconstitute(props: ReconstituteNotificacaoProps): Notificacao {
    return new Notificacao(
      {
        clienteId: props.clienteId,
        ordemDeServicoId: props.ordemDeServicoId,
        numeroOS: props.numeroOS ?? null,
        eventoId: props.eventoId ?? null,
        linkPagamento: props.linkPagamento ?? null,
        tipo: props.tipo,
        canal: props.canal,
        destinatario: props.destinatario,
        assunto: props.assunto,
        mensagem: props.mensagem,
        status: props.status,
        erro: props.erro,
        enviadaEm: props.enviadaEm,
        createdAt: props.createdAt,
      },
      props.id,
    );
  }

  marcarComoEnviada(enviadaEm: Date = new Date()): void {
    this._status = StatusNotificacao.ENVIADA;
    this._enviadaEm = enviadaEm;
    this._erro = null;
  }

  marcarComoFalha(erro: string): void {
    this._status = StatusNotificacao.FALHOU;
    this._erro = erro;
    this._enviadaEm = null;
  }

  get clienteId(): string {
    return this._clienteId;
  }
  get ordemDeServicoId(): string | null {
    return this._ordemDeServicoId;
  }
  get numeroOS(): string | null {
    return this._numeroOS;
  }
  get eventoId(): string | null {
    return this._eventoId;
  }
  get linkPagamento(): string | null {
    return this._linkPagamento;
  }
  get tipo(): TipoNotificacao {
    return this._tipo;
  }
  get canal(): CanalNotificacao {
    return this._canal;
  }
  get destinatario(): string {
    return this._destinatario;
  }
  get assunto(): string {
    return this._assunto;
  }
  get mensagem(): string {
    return this._mensagem;
  }
  get status(): StatusNotificacao {
    return this._status;
  }
  get erro(): string | null {
    return this._erro;
  }
  get enviadaEm(): Date | null {
    return this._enviadaEm;
  }
  get createdAt(): Date | undefined {
    return this._createdAt;
  }
}
