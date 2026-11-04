import { Inject, Injectable } from '@nestjs/common';
import { UseCase, DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { registrarTransicao } from './registrar-transicao.base';

export interface RegistrarExecucaoFinalizadaInput {
  numero: string;
  /** Unit of work do orquestrador (OS + saga na mesma transacao). */
  tx?: unknown;
}

/**
 * `execucao.finalizada` -> AGUARDANDO_PAGAMENTO (ADR-0012: a cobranca vem depois
 * do servico executado). `os.finalizada` so sai com `billing.pagamento-aprovado`.
 */
@Injectable()
export class RegistrarExecucaoFinalizadaUseCase implements UseCase<RegistrarExecucaoFinalizadaInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly gateway: OrdemDeServicoGateway,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  async execute(input: RegistrarExecucaoFinalizadaInput): Promise<OrdemDeServico> {
    const { ordem } = await registrarTransicao(this.gateway, this.events, input.numero, StatusOS.AGUARDANDO_PAGAMENTO, (os) =>
      os.aguardarPagamento(),
      input.tx,
    );
    return ordem;
  }
}
