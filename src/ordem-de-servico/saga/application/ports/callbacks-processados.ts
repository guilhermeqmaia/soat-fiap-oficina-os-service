/**
 * Deduplicacao dos callbacks `POST /ordens-servico/:numero/eventos` pelo `id`
 * do envelope (tabela `processed_messages`). `marcar` devolve `false` quando o
 * id ja existia (duas entregas simultaneas do mesmo callback).
 */
export interface CallbacksProcessados {
  jaProcessado(id: string): Promise<boolean>;
  marcar(id: string, type: string): Promise<boolean>;
  /** Remove marcas mais antigas que `antesDe`; devolve quantas apagou. */
  purgar(antesDe: Date): Promise<number>;
}
export const CALLBACKS_PROCESSADOS = Symbol('CALLBACKS_PROCESSADOS');
