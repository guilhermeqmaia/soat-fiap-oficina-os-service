import { ComandoSaga, EventoSaga } from '../../domain/saga-os.entity';

/**
 * Resultado de um comando enviado a um participante (Execucao/Billing) por HTTP
 * (RFC-0008). `entregue: true` traz a resposta sincrona JA traduzida para o
 * evento da saga (201/200 = evento de sucesso; 409 = evento de recusa com
 * `motivo`). `entregue: false` = tentativas esgotadas (5xx/timeout/rede) ou
 * resposta inesperada: a saga fica no passo e o alerta de saga parada /
 * `POST /admin/sagas/:numero/reprocessar` reenviam.
 */
export type ResultadoComando =
  | { entregue: true; evento: EventoSaga }
  | { entregue: false; erro: string; status?: number };

/** Porta de saida do orquestrador para os participantes da saga. */
export interface ParticipantesSagaGateway {
  executar(comando: ComandoSaga): Promise<ResultadoComando>;
}
export const PARTICIPANTES_SAGA_GATEWAY = Symbol('PARTICIPANTES_SAGA_GATEWAY');
