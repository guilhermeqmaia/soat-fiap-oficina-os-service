import { Inject, Injectable } from '@nestjs/common';
import { UseCase, DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { OsFinalizadaEvent } from '../../../../shared/domain/events/os-finalizada.event';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { registrarTransicao } from './registrar-transicao.base';

export interface RegistrarPagamentoAprovadoInput {
  numero: string;
  /** Unit of work do orquestrador (OS + saga + outbox na mesma transacao). */
  tx?: unknown;
  /** id do envelope `billing.pagamento-aprovado` (ADR-0009) — vai em `os.finalizada`. */
  causationId?: string;
}

/**
 * `billing.pagamento-aprovado` -> FINALIZADA + `os.finalizada` + notificacao
 * "veiculo pronto". A cobranca acontece depois do servico executado (ADR-0012),
 * por isso e o pagamento — e nao o fim da execucao — que finaliza a OS.
 */
@Injectable()
export class RegistrarPagamentoAprovadoUseCase implements UseCase<RegistrarPagamentoAprovadoInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly gateway: OrdemDeServicoGateway,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  async execute(input: RegistrarPagamentoAprovadoInput): Promise<OrdemDeServico> {
    const { ordem, aplicada } = await registrarTransicao(this.gateway, this.events, input.numero, StatusOS.FINALIZADA, (os) =>
      os.finalizar(input.causationId),
      input.tx,
    );
    if (aplicada && ordem.id) {
      this.events.publish(new OsFinalizadaEvent(ordem.id, ordem.numero, ordem.clienteId));
    }
    return ordem;
  }
}
