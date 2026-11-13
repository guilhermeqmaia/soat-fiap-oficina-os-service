import { StubHttp } from './stub-http';

/**
 * Execucao e Billing falsos, respondendo como `docs/contratos/http-interno.md`
 * (sucesso = 201/200 com o corpo do evento equivalente). O OS Service fala com
 * eles pelo `HttpParticipantesSaga` REAL (cliente HTTP do kit, JWT de servico,
 * retry) — so a outra ponta e falsa.
 *
 * Para os outros servicos: troque estas tabelas pelas rotas que o SEU servico
 * consome (ex.: no Billing, o callback `POST /ordens-servico/{n}/eventos` do OS
 * Service e a API do Mercado Pago).
 */
export function stubExecucao(): StubHttp {
  return new StubHttp({
    'POST /execucao/ordens': (c) => ({ status: 201, body: { numeroOS: c.body?.numeroOS, posicaoFila: 1 } }),
    'POST /execucao/ordens/{n}/iniciar': (c) => ({ status: 200, body: { numeroOS: c.params.n, iniciadaEm: new Date().toISOString() } }),
    'DELETE /execucao/ordens/{n}': (c) => ({ status: 200, body: { numeroOS: c.params.n, reservasLiberadas: true } }),
  });
}

let seqOrder = 0;

export function stubBilling(): StubHttp {
  return new StubHttp({
    'POST /orcamentos': (c) => {
      const itens: Array<{ quantidade: number; precoUnitario: string | number }> = c.body?.itens ?? [];
      const total = itens.reduce((acc, i) => acc + i.quantidade * Number(i.precoUnitario), 0).toFixed(2);
      return {
        status: 201,
        body: { numeroOS: c.body?.numeroOS, orcamentoId: `orc-${c.body?.numeroOS}`, total, validoAte: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      };
    },
    'POST /orcamentos/{n}/cobrar': (c) => {
      const orderId = `mp-${++seqOrder}`;
      return { status: 201, body: { numeroOS: c.params.n, orderId, linkPagamento: `https://mp.test/pay/${orderId}`, valor: '300.00' } };
    },
    'DELETE /orcamentos/{n}': (c) => ({ status: 200, body: { numeroOS: c.params.n, orcamentoId: `orc-${c.params.n}`, estornado: false } }),
  });
}

/** Nome do participante na linguagem dos .feature -> chave interna. */
export type Participante = 'Execução' | 'Billing';
