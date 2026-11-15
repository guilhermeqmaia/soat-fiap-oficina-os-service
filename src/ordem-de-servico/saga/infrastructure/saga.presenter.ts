import { SagaOS } from '../domain/saga-os.entity';

/** Linha do tempo da saga para GET /ordens-servico/:numero/saga (video + dashboard). */
export class SagaPresenter {
  static toResponse(saga: SagaOS) {
    return {
      numero: saga.numero,
      passo: saga.passo,
      status: saga.status,
      prazoAprovacao: saga.prazoAprovacao,
      prazoPagamento: saga.prazoPagamento,
      falhaSimulada: saga.falhaSimulada,
      historico: saga.historico,
      compensacoes: saga.compensacoes,
      /** Comandos nao entregues aguardando reprocessamento (alerta "saga parada"). */
      falhasPendentes: saga.falhasPendentes,
      iniciadaEm: saga.createdAt,
      atualizadaEm: saga.updatedAt,
    };
  }
}
