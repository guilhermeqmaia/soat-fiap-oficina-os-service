import type { ClienteHttpTeste, RespostaHttp } from './http-client';
import type { Participante } from './participantes-stub';
import type { ChamadaRecebida, RespostaStub } from './stub-http';
import type { MundoOS, ServicoCallback } from './world';

/**
 * Estado compartilhado pela execucao inteira (montado uma vez nos hooks
 * `BeforeAll` do perfil). O World de cada cenario le daqui.
 *
 * - perfil `default` (nivel de servico): `http` aponta para o Nest em memoria e
 *   `stubs` sao os `StubHttp` locais; os callbacks saem direto do teste;
 * - perfil `e2e` (ponta a ponta): `http` aponta para o os-service do compose,
 *   `stubs` sao os containers de e2e/stubs controlados por HTTP (`/__stub/*`) e
 *   `acionadorCallbacks` dispara os callbacks pelas acoes do participante
 *   (mecanico diagnostica, cliente aprova...) — o callback sai do participante.
 */
export interface ContextoExecucao {
  http: ClienteHttpTeste;
  stubs: Partial<Record<Participante, ControleParticipante>>;
  /** `usuario.id` de um MECANICO existente (o diagnostico referencia o mecanico). */
  mecanicoId: string;
  acionadorCallbacks?: AcionadorCallbacks;
}

/**
 * O que os steps de participante precisam de um stub: chamadas recebidas e
 * respostas forcadas. `StubHttp` (em memoria, sincrono) e `ParticipanteRemoto`
 * (container, assincrono) implementam — os steps sempre usam `await`.
 */
export interface ControleParticipante {
  chamadasEm(rota: string): ChamadaRecebida[] | Promise<ChamadaRecebida[]>;
  responder(rota: string, resposta: RespostaStub): void | Promise<void>;
  restaurar(rota?: string): void | Promise<void>;
}

/** Quem dispara os callbacks quando eles nao saem do proprio teste. */
export interface AcionadorCallbacks {
  enviar(mundo: MundoOS, servico: ServicoCallback, type: string, dados: Record<string, unknown>): Promise<RespostaHttp>;
  reenviar(mundo: MundoOS, servico: ServicoCallback): Promise<RespostaHttp>;
}

let atual: ContextoExecucao | undefined;

export function definirContexto(c: ContextoExecucao): void {
  atual = c;
}

export function contexto(): ContextoExecucao {
  if (!atual) throw new Error('Contexto BDD nao inicializado: confira se o perfil carrega os hooks (features/support/servico ou e2e).');
  return atual;
}

export function stubDe(participante: Participante): ControleParticipante {
  const stub = contexto().stubs[participante];
  if (!stub) throw new Error(`Nao ha stub HTTP para "${participante}" neste perfil (com as imagens reais nao ha /__stub; rode so os cenarios sem @stub).`);
  return stub;
}
