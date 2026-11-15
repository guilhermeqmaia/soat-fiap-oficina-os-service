import type { ResultadoCallback } from './callbacks';
import type { Resposta } from './servidor';

/**
 * Resposta das acoes de pessoa/Mercado Pago (diagnostico, aprovar, pagar...).
 * `callback` e um campo SO do stub: devolve o que o OS respondeu ao callback,
 * para o BDD e o roteiro manual verem `aplicado`/`duplicado` sem ler o log.
 */
export function respostaDaAcao(numeroOS: string, estado: unknown, callback: ResultadoCallback): Resposta {
  return { status: 200, body: { numeroOS, estado, callback } };
}

export function conflito(motivo: string): Resposta {
  return { status: 409, body: { motivo } };
}

export function naoEncontrada(numeroOS: string): Resposta {
  return { status: 404, body: { statusCode: 404, message: `OS ${numeroOS} desconhecida neste servico` } };
}
