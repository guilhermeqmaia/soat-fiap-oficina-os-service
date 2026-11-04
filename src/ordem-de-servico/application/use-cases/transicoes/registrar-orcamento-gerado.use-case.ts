import { Inject, Injectable } from '@nestjs/common';
import { UseCase, DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { OrcamentoProntoEvent } from '../../../../shared/domain/events/orcamento-pronto.event';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { registrarTransicao } from './registrar-transicao.base';

export interface RegistrarOrcamentoGeradoInput {
  numero: string;
  /** Unit of work do orquestrador (OS + saga na mesma transacao). */
  tx?: unknown;
  /** Total do orcamento calculado pelo Billing (string decimal ou numero). */
  total: string | number;
}

/** `billing.orcamento-gerado` -> AGUARDANDO_APROVACAO + notificacao ao cliente. */
@Injectable()
export class RegistrarOrcamentoGeradoUseCase implements UseCase<RegistrarOrcamentoGeradoInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly gateway: OrdemDeServicoGateway,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  async execute(input: RegistrarOrcamentoGeradoInput): Promise<OrdemDeServico> {
    const { ordem, aplicada } = await registrarTransicao(
      this.gateway,
      this.events,
      input.numero,
      StatusOS.AGUARDANDO_APROVACAO,
      (os) => os.aguardarAprovacao(),
      input.tx
    );
    if (aplicada && ordem.id) {
      this.events.publish(
        new OrcamentoProntoEvent(ordem.id, ordem.numero, ordem.clienteId, ordem.diagnostico ?? '', Number(input.total)),
      );
    }
    return ordem;
  }
}
