import { Notificacao } from './notificacao.entity';

export interface FindAllParams {
  page: number;
  limit: number;
  clienteId?: string;
  ordemDeServicoId?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface NotificacaoRepository {
  create(notificacao: Notificacao): Promise<Notificacao>;
  /**
   * Idempotencia (US-F4-12): grava a notificacao ANTES do envio, como reserva.
   * Devolve `null` quando ja existe uma notificacao para o mesmo
   * (eventoId, tipo, canal) — o fato ja foi notificado e nao deve ser reenviado.
   * Sem `eventoId` nao ha deduplicacao (sempre grava).
   */
  reservar(notificacao: Notificacao): Promise<Notificacao | null>;
  /** Grava o resultado do envio (status, erro, enviadaEm) de uma notificacao reservada. */
  atualizarResultado(notificacao: Notificacao): Promise<Notificacao>;
  findById(id: string): Promise<Notificacao | null>;
  findAll(params: FindAllParams): Promise<PaginatedResult<Notificacao>>;
}

export const NOTIFICACAO_REPOSITORY = Symbol('NotificacaoRepository');
