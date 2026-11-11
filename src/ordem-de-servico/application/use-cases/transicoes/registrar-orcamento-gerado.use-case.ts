import { Inject, Injectable } from '@nestjs/common';
import { UseCase, DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { registrarTransicao } from './registrar-transicao.base';

export interface RegistrarOrcamentoGeradoInput {
  numero: string;
  /** Unit of work do orquestrador (OS + saga na mesma transacao). */
  tx?: unknown;
  /** Coletor do orquestrador: eventos publicados so depois do commit (default: publisher direto). */
  eventos?: DomainEventPublisher;
  /** Total do orcamento calculado pelo Billing (string decimal ou numero). */
  total: string | number;
}

/**
 * `billing.orcamento-gerado` -> AGUARDANDO_APROVACAO. A notificacao "orcamento
 * pronto" sai do marco `billing.orcamento-gerado` publicado pelo orquestrador
 * apos o commit (origem unica, US-F4-12) — este use case so transiciona a OS.
 */
@Injectable()
export class RegistrarOrcamentoGeradoUseCase implements UseCase<RegistrarOrcamentoGeradoInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly gateway: OrdemDeServicoGateway,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  async execute(input: RegistrarOrcamentoGeradoInput): Promise<OrdemDeServico> {
    const { ordem } = await registrarTransicao(
      this.gateway,
      input.eventos ?? this.events,
      input.numero,
      StatusOS.AGUARDANDO_APROVACAO,
      (os) => os.aguardarAprovacao(),
      input.tx
    );
    return ordem;
  }
}
