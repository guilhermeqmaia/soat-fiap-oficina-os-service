import { Inject, Injectable } from '@nestjs/common';
import { UseCase, DOMAIN_EVENT_PUBLISHER, DomainEventPublisher } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../../domain/ordem-de-servico.entity';
import { StatusOS } from '../../../domain/value-objects/status-os.vo';
import { MarcoOrdemDeServicoEvent } from '../../../../shared/domain/events/marco-ordem-de-servico.event';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../../gateways/ordem-de-servico.gateway';
import { registrarTransicao } from './registrar-transicao.base';

export interface RegistrarPagamentoAprovadoInput {
  numero: string;
  /** Unit of work do orquestrador (OS + saga na mesma transacao). */
  tx?: unknown;
  /** Coletor do orquestrador: eventos publicados so depois do commit (default: publisher direto). */
  eventos?: DomainEventPublisher;
}

/**
 * `billing.pagamento-aprovado` -> FINALIZADA + marco `os.finalizada` (notificacao
 * "veiculo pronto", in-process, publicada apos o commit). A cobranca acontece depois do servico executado (ADR-0012),
 * por isso e o pagamento — e nao o fim da execucao — que finaliza a OS.
 */
@Injectable()
export class RegistrarPagamentoAprovadoUseCase implements UseCase<RegistrarPagamentoAprovadoInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY) private readonly gateway: OrdemDeServicoGateway,
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly events: DomainEventPublisher,
  ) {}

  async execute(input: RegistrarPagamentoAprovadoInput): Promise<OrdemDeServico> {
    const { ordem, aplicada } = await registrarTransicao(this.gateway, input.eventos ?? this.events, input.numero, StatusOS.FINALIZADA, (os) =>
      os.finalizar(),
      input.tx,
    );
    if (aplicada && ordem.id) {
      // FINALIZADA e terminal: no maximo uma vez por OS -> id do fato deterministico.
      (input.eventos ?? this.events).publish(
        new MarcoOrdemDeServicoEvent('os.finalizada', ordem.numero, ordem.id, ordem.clienteId, `os.finalizada:${ordem.numero}`),
      );
    }
    return ordem;
  }
}
