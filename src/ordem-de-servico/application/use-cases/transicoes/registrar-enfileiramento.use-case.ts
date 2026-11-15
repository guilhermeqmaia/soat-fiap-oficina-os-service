import { Inject, Injectable } from '@nestjs/common';
import { UseCase, DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { registrarTransicao } from './registrar-transicao.base';

export interface RegistrarEnfileiramentoInput {
  numero: string;
  /** Unit of work do orquestrador (OS + saga na mesma transacao). */
  tx?: unknown;
  /** Coletor do orquestrador: eventos publicados so depois do commit (default: publisher direto). */
  eventos?: DomainEventPublisher;
}

/** `execucao.enfileirada` -> EM_DIAGNOSTICO. */
@Injectable()
export class RegistrarEnfileiramentoUseCase implements UseCase<RegistrarEnfileiramentoInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly gateway: OrdemDeServicoGateway,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  async execute(input: RegistrarEnfileiramentoInput): Promise<OrdemDeServico> {
    const { ordem } = await registrarTransicao(this.gateway, input.eventos ?? this.events, input.numero, StatusOS.EM_DIAGNOSTICO, (os) =>
      os.iniciarDiagnostico(),
      input.tx,
    );
    return ordem;
  }
}
