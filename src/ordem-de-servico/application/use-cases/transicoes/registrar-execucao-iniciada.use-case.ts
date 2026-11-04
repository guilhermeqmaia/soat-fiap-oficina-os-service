import { Inject, Injectable } from '@nestjs/common';
import { UseCase, DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { registrarTransicao } from './registrar-transicao.base';

export interface RegistrarExecucaoIniciadaInput {
  numero: string;
  /** Unit of work do orquestrador (OS + saga na mesma transacao). */
  tx?: unknown;
}

/** `execucao.iniciada` -> EM_EXECUCAO (a aprovacao do orcamento, por si, nao muda a OS). */
@Injectable()
export class RegistrarExecucaoIniciadaUseCase implements UseCase<RegistrarExecucaoIniciadaInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly gateway: OrdemDeServicoGateway,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  async execute(input: RegistrarExecucaoIniciadaInput): Promise<OrdemDeServico> {
    const { ordem } = await registrarTransicao(this.gateway, this.events, input.numero, StatusOS.EM_EXECUCAO, (os) =>
      os.iniciarExecucao(),
      input.tx
    );
    return ordem;
  }
}
