import { Inject, Injectable } from '@nestjs/common';
import { UseCase, DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { MotivoCancelamento } from '../../../domain/value-objects/motivo-cancelamento';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { registrarTransicao } from './registrar-transicao.base';

export interface RegistrarCancelamentoInput {
  numero: string;
  /** Unit of work do orquestrador (OS + saga na mesma transacao). */
  tx?: unknown;
  motivo: MotivoCancelamento;
}

/** Compensacoes da saga (orcamento rejeitado, execucao recusada, timeout de aprovacao) ou cancelamento manual -> CANCELADA. */
@Injectable()
export class RegistrarCancelamentoUseCase implements UseCase<RegistrarCancelamentoInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly gateway: OrdemDeServicoGateway,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  async execute(input: RegistrarCancelamentoInput): Promise<OrdemDeServico> {
    const { ordem } = await registrarTransicao(this.gateway, this.events, input.numero, StatusOS.CANCELADA, (os) =>
      os.cancelar(input.motivo),
      input.tx
    );
    return ordem;
  }
}
