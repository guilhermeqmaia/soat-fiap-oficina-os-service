import { DomainEvent } from '@guilhermeqmaia/oficina-kit/core';

/**
 * Evento publicado a cada mutacao da OrdemDeServico (criar, atribuir
 * mecanico, completar diagnostico, aprovar, rejeitar, finalizar, entregar,
 * adicionar/remover servico, adicionar/remover produto, iniciar/concluir
 * servico, deletar).
 *
 * Consumido pelo audit log para registrar quem fez o que e quando.
 *
 * Distinto de `MarcoOrdemDeServicoEvent`, que e um evento de
 * NEGOCIO (orientam acoes em outros BCs como Notificacao).
 * Este evento eh tecnico e foca em rastreabilidade.
 */
export class OsAcaoEvent extends DomainEvent {
  static readonly EVENT_NAME = 'os.acao';
  readonly eventName = OsAcaoEvent.EVENT_NAME;

  constructor(
    public readonly ordemDeServicoId: string,
    public readonly numero: string,
    public readonly acao: string,
    public readonly statusAnterior: string | null,
    public readonly statusNovo: string | null,
    public readonly usuarioId: string | null,
    public readonly metadata: Record<string, unknown> | null = null,
  ) {
    super();
  }
}
