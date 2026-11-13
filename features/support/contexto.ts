import type { ClienteHttpTeste } from './http-client';
import type { StubHttp } from './stub-http';
import type { Participante } from './participantes-stub';

/**
 * Estado compartilhado pela execucao inteira (montado uma vez nos hooks
 * `BeforeAll` do perfil). O World de cada cenario le daqui.
 *
 * - perfil `default` (nivel de servico): `http` aponta para o Nest em memoria e
 *   `stubs` tem a Execucao/Billing falsos;
 * - perfil `e2e` (ponta a ponta): `http` aponta para o servico real e `stubs`
 *   fica vazio (steps que dependem de stub falham com mensagem clara).
 */
export interface ContextoExecucao {
  http: ClienteHttpTeste;
  stubs: Partial<Record<Participante, StubHttp>>;
  /** `usuario.id` de um MECANICO existente (o diagnostico referencia o mecanico). */
  mecanicoId: string;
}

let atual: ContextoExecucao | undefined;

export function definirContexto(c: ContextoExecucao): void {
  atual = c;
}

export function contexto(): ContextoExecucao {
  if (!atual) throw new Error('Contexto BDD nao inicializado: confira se o perfil carrega os hooks (features/support/servico ou e2e).');
  return atual;
}

export function stubDe(participante: Participante): StubHttp {
  const stub = contexto().stubs[participante];
  if (!stub) throw new Error(`Nao ha stub HTTP para "${participante}" neste perfil (no ponta a ponta o servico e real).`);
  return stub;
}
