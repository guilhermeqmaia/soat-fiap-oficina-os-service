import { BDD } from './env';

/**
 * Espera ate `consulta()` devolver um valor que passe em `condicao` (sem `sleep`
 * fixo): repete a cada `intervaloMs` ate `timeoutMs`. Se esgotar, falha com o
 * ultimo valor lido — a mensagem mostra o que o servico tinha naquele momento.
 *
 * `condicao` pode lancar (ex.: um `expect`): a excecao conta como "ainda nao" e
 * a ultima e relancada no timeout, preservando o diff do `expect`.
 */
export async function aguardarAte<T>(
  descricao: string,
  consulta: () => Promise<T>,
  condicao: (valor: T) => boolean | void,
  opcoes: { timeoutMs?: number; intervaloMs?: number } = {},
): Promise<T> {
  const timeoutMs = opcoes.timeoutMs ?? BDD.timeoutMs;
  const intervaloMs = opcoes.intervaloMs ?? BDD.intervaloMs;
  const limite = Date.now() + timeoutMs;
  let ultimo: T | undefined;
  let ultimoErro: unknown;
  for (;;) {
    try {
      ultimo = await consulta();
      if (condicao(ultimo) !== false) return ultimo;
      ultimoErro = undefined;
    } catch (e) {
      ultimoErro = e;
    }
    if (Date.now() >= limite) break;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  if (ultimoErro instanceof Error) {
    ultimoErro.message = `Timeout (${timeoutMs} ms) esperando ${descricao}\n${ultimoErro.message}`;
    throw ultimoErro;
  }
  throw new Error(`Timeout (${timeoutMs} ms) esperando ${descricao}. Ultimo valor: ${JSON.stringify(ultimo, null, 2)}`);
}
