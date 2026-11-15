import { CanalNotificacao } from '../../domain/value-objects/canal-notificacao.vo';

export interface MensagemNotificacao {
  destinatario: string;
  assunto: string;
  corpo: string;
  contexto?: {
    ordemId?: string;
    clienteId?: string;
    /** US-F4-12: payload do webhook `{ numeroOS, tipo, mensagem, linkPagamento? }`. */
    numeroOS?: string;
    linkPagamento?: string;
    eventoId?: string;
    statusAnterior?: string;
    statusAtual?: string;
    timestamp?: Date | string;
    tipoNotificacao?: string;
  };
}

export interface Notificador {
  readonly canal: CanalNotificacao;
  enviar(mensagem: MensagemNotificacao): Promise<void>;
}

export const NOTIFICADOR = Symbol('Notificador');
