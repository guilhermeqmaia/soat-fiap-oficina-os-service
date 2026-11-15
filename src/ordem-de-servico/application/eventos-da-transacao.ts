import { DomainEvent, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';

/**
 * Publisher que ACUMULA os eventos de dominio de uma tentativa de transacao.
 *
 * Os listeners (notificacao, auditoria, metricas) sao sincronos ao `publish`
 * do `EventEmitterDomainEventPublisher`; publicar dentro da transacao faz o
 * listener ver um fato que ainda pode ser revertido (conflito de versao ->
 * rollback -> retry no orquestrador). O orquestrador cria um coletor por
 * tentativa, passa-o aos use cases de transicao e so chama `descarregarEm`
 * depois do commit bem-sucedido. Tentativa revertida = coletor descartado.
 */
export class EventosDaTransacao implements DomainEventPublisher {
  private readonly eventos: DomainEvent[] = [];

  publish(event: DomainEvent): void {
    this.eventos.push(event);
  }

  /** Publica, na ordem em que foram gerados, os eventos acumulados e esvazia o coletor. */
  descarregarEm(destino: DomainEventPublisher): void {
    const eventos = this.eventos.splice(0, this.eventos.length);
    for (const e of eventos) destino.publish(e);
  }
}
