import { Injectable } from '@nestjs/common';
import { MessageEnvelope, MessageHandler } from '@guilhermeqmaia/oficina-kit/messaging';
import { OrquestradorSagaService } from '../../saga/application/orquestrador-saga.service';

/**
 * Handlers da fila `os-eventos.fifo` (AsyncAPI: canais `oficina-execucao` e
 * `oficina-billing`). Todos entregam o evento ao orquestrador da saga
 * (US-F4-10), que decide a transicao da OS e os comandos a enviar.
 * Idempotencia: o SqsConsumer do kit descarta ids ja processados; a saga
 * ignora duplicados/fora de ordem; erro (OS inexistente, conflito) -> retry -> DLQ.
 */
// @Injectable na base: e dela que o Nest le os parametros do construtor (as
// subclasses nao declaram construtor e herdam a metadata pelo prototype).
@Injectable()
abstract class EventoSagaHandler implements MessageHandler<Record<string, unknown>> {
  abstract readonly type: string;
  constructor(protected readonly orquestrador: OrquestradorSagaService) {}
  async handle(envelope: MessageEnvelope<Record<string, unknown>>): Promise<void> {
    await this.orquestrador.processar({ type: envelope.type, id: envelope.id, data: envelope.data });
  }
}

@Injectable()
export class ExecucaoEnfileiradaHandler extends EventoSagaHandler {
  readonly type = 'execucao.enfileirada';
}
@Injectable()
export class ExecucaoRecusadaHandler extends EventoSagaHandler {
  readonly type = 'execucao.recusada';
}
@Injectable()
export class ExecucaoDiagnosticoConcluidoHandler extends EventoSagaHandler {
  readonly type = 'execucao.diagnostico-concluido';
}
@Injectable()
export class ExecucaoIniciadaHandler extends EventoSagaHandler {
  readonly type = 'execucao.iniciada';
}
@Injectable()
export class ExecucaoFinalizadaHandler extends EventoSagaHandler {
  readonly type = 'execucao.finalizada';
}
@Injectable()
export class ExecucaoReservasLiberadasHandler extends EventoSagaHandler {
  readonly type = 'execucao.reservas-liberadas';
}
@Injectable()
export class BillingOrcamentoGeradoHandler extends EventoSagaHandler {
  readonly type = 'billing.orcamento-gerado';
}
@Injectable()
export class BillingOrcamentoAprovadoHandler extends EventoSagaHandler {
  readonly type = 'billing.orcamento-aprovado';
}
@Injectable()
export class BillingOrcamentoRejeitadoHandler extends EventoSagaHandler {
  readonly type = 'billing.orcamento-rejeitado';
}
@Injectable()
export class BillingCobrancaCriadaHandler extends EventoSagaHandler {
  readonly type = 'billing.cobranca-criada';
}
@Injectable()
export class BillingPagamentoAprovadoHandler extends EventoSagaHandler {
  readonly type = 'billing.pagamento-aprovado';
}
@Injectable()
export class BillingPagamentoRecusadoHandler extends EventoSagaHandler {
  readonly type = 'billing.pagamento-recusado';
}
@Injectable()
export class BillingOrcamentoCanceladoHandler extends EventoSagaHandler {
  readonly type = 'billing.orcamento-cancelado';
}
