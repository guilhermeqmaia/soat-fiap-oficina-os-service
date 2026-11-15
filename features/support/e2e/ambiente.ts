import type { AcionadorCallbacks } from '../contexto';
import { ClienteHttpTeste, RespostaHttp } from '../http-client';
import { tokenDe } from '../tokens';
import type { MundoOS, ServicoCallback } from '../world';
import { URLS_E2E } from './00-env';
import { ParticipanteRemoto } from './participante-remoto';

/**
 * Pecas do ambiente ponta a ponta (docker-compose.fase4.yml) usadas pelos hooks
 * e pelos steps de features/step-definitions/e2e.
 */
export const participantes = {
  Execução: new ParticipanteRemoto('Execução', URLS_E2E.execucao),
  Billing: new ParticipanteRemoto('Billing', URLS_E2E.billing),
};

export const mailpit = new ClienteHttpTeste(URLS_E2E.mailpit);

/** Resposta da acao do stub -> o que o OS respondeu ao callback (`callback.status/body`). */
function comoRespostaDoCallback(res: RespostaHttp): RespostaHttp {
  const cb = res.body?.callback;
  return cb ? { status: cb.status, body: cb.body, headers: res.headers } : res;
}

/**
 * O callback sai do PARTICIPANTE, disparado pela acao da pessoa (ou do Mercado
 * Pago) no servico dele — como em producao:
 *   execucao.diagnostico-concluido  POST /execucao/ordens/{n}/diagnostico (MECANICO)
 *   execucao.finalizada             POST /execucao/ordens/{n}/finalizar   (MECANICO)
 *   billing.orcamento-aprovado      POST /orcamentos/{n}/aprovar          (CLIENTE)
 *   billing.orcamento-rejeitado     POST /orcamentos/{n}/rejeitar         (CLIENTE)
 *   billing.pagamento-aprovado|recusado  POST /__stub/pagamentos/{n}  (webhook do MP simulado)
 */
export const acionadorE2e: AcionadorCallbacks = {
  async enviar(mundo: MundoOS, servico: ServicoCallback, type: string, dados: Record<string, unknown>): Promise<RespostaHttp> {
    const n = encodeURIComponent(mundo.ordem.numero);
    const cliente = () => tokenDe('cliente', { cpf: mundo.cliente!.cpf });
    const exec = participantes.Execução.http;
    const bill = participantes.Billing.http;
    const acoes: Record<string, () => Promise<RespostaHttp>> = {
      'execucao.diagnostico-concluido': () =>
        exec.post(`/execucao/ordens/${n}/diagnostico`, { mecanicoId: dados.mecanicoId, diagnostico: dados.diagnostico, itens: dados.itens }, tokenDe('mecanico')),
      'execucao.finalizada': () => exec.post(`/execucao/ordens/${n}/finalizar`, undefined, tokenDe('mecanico')),
      'billing.orcamento-aprovado': () => bill.post(`/orcamentos/${n}/aprovar`, undefined, cliente()),
      'billing.orcamento-rejeitado': () => bill.post(`/orcamentos/${n}/rejeitar`, { motivo: dados.motivo }, cliente()),
      'billing.pagamento-aprovado': () => bill.post(`/__stub/pagamentos/${n}`, { resultado: 'aprovado' }),
      'billing.pagamento-recusado': () => bill.post(`/__stub/pagamentos/${n}`, { resultado: 'recusado', motivo: dados.motivo }),
    };
    const acao = acoes[type];
    if (!acao) throw new Error(`Sem acao no participante para o callback "${type}" (servico ${servico}).`);
    return comoRespostaDoCallback(await acao());
  },

  async reenviar(mundo: MundoOS, servico: ServicoCallback): Promise<RespostaHttp> {
    const res = await participantes[servico].http.post(`/__stub/callbacks/${encodeURIComponent(mundo.ordem.numero)}/reenviar`);
    return comoRespostaDoCallback(res);
  },
};

/** Pagamento pelo resultado do cenario do stub (`POST /__stub/cenario { pagamento }`). */
export async function pagar(mundo: MundoOS): Promise<RespostaHttp> {
  const res = await participantes.Billing.http.post(`/__stub/pagamentos/${encodeURIComponent(mundo.ordem.numero)}`, {});
  mundo.ultimoCallback = { servico: 'Billing' };
  mundo.ultimaResposta = comoRespostaDoCallback(res);
  return mundo.ultimaResposta;
}

// ---------------------------------------------------------------- /metrics

/** Soma das series de `nome` cujos labels contem `filtro` (texto do Prometheus). */
export function valorMetrica(texto: string, nome: string, filtro: Record<string, string>): number {
  let soma = 0;
  for (const linha of texto.split('\n')) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(linha.trim());
    if (!m || m[1] !== nome) continue;
    const labels = Object.fromEntries([...(m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((l) => [l[1], l[2]]));
    if (Object.entries(filtro).every(([k, v]) => labels[k] === v)) soma += Number(m[3]);
  }
  return soma;
}

/** `type="x",resultado="y"` -> { type: 'x', resultado: 'y' } */
export function labels(texto: string): Record<string, string> {
  return Object.fromEntries([...texto.matchAll(/(\w+)="([^"]*)"/g)].map((l) => [l[1], l[2]]));
}
