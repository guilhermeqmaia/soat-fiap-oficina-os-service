import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { conflito, naoEncontrada, respostaDaAcao } from './comum/acoes';
import { EmissorCallbacks } from './comum/callbacks';
import { criarLog } from './comum/log';
import { ServidorStub } from './comum/servidor';

/**
 * Billing Service FALSO (porta 3001) — `docs/contratos/http-interno.md`,
 * secao "OS Service -> Billing Service". Estado em memoria, idempotente por
 * numeroOS. Troque pela imagem real com `BILLING_IMAGE` no compose.
 *
 * Contrato (role SERVICO):
 *   POST   /orcamentos               201 { numeroOS, orcamentoId, total, validoAte } | 200 mesmo corpo se ja existe ativo
 *   POST   /orcamentos/{n}/cobrar    201 { numeroOS, orderId, linkPagamento, valor } | 409 { motivo } nao aprovado / ja pago
 *   DELETE /orcamentos/{n}           200 { numeroOS, orcamentoId|null, estornado:false } | 409 { motivo } ja pago
 * Acoes do cliente (CLIENTE/ADMIN) que geram callback ao OS:
 *   POST   /orcamentos/{n}/aprovar   -> billing.orcamento-aprovado
 *   POST   /orcamentos/{n}/rejeitar  -> billing.orcamento-rejeitado
 * Mercado Pago (ponto de troca): no servico real o resultado chega pelo webhook
 * `order.processed` assinado; aqui `POST /__stub/pagamentos/{n}` simula esse
 * webhook (resultado = corpo ou `cenario.pagamento`) -> billing.pagamento-aprovado|recusado.
 * O link de pagamento e falso: `${LINK_PAGAMENTO_BASE}/mp-<numero>`.
 */
type StatusOrcamento = 'PENDENTE' | 'APROVADO' | 'REJEITADO' | 'CANCELADO' | 'PAGO';

interface Cobranca {
  orderId: string;
  linkPagamento: string;
  valor: string;
  status: 'PENDENTE' | 'APROVADA' | 'RECUSADA';
  criadaEm: string;
}

interface Orcamento {
  numeroOS: string;
  orcamentoId: string;
  clienteId: string;
  total: string;
  validoAte: string;
  status: StatusOrcamento;
  itens: unknown[];
  cobrancas: Cobranca[];
  motivo?: string;
  historico: Array<{ em: string; evento: string }>;
}

const SERVICO = 'billing-service';
const log = criarLog(SERVICO);
const servidor = new ServidorStub(SERVICO, log);
const callbacks = new EmissorCallbacks(SERVICO, servidor);
const orcamentos = new Map<string, Orcamento>();
const LINK_BASE = (process.env.LINK_PAGAMENTO_BASE ?? 'https://mp.test/pay').replace(/\/+$/, '');
let seqOrder = 0;

const marcar = (o: Orcamento, evento: string) => o.historico.push({ em: new Date().toISOString(), evento });
const corpoOrcamento = (o: Orcamento) => ({ numeroOS: o.numeroOS, orcamentoId: o.orcamentoId, total: o.total, validoAte: o.validoAte });
const corpoCobranca = (o: Orcamento, c: Cobranca) => ({ numeroOS: o.numeroOS, orderId: c.orderId, linkPagamento: c.linkPagamento, valor: c.valor });
const ultimaCobranca = (o: Orcamento) => o.cobrancas[o.cobrancas.length - 1];

function total(itens: Array<{ quantidade: number; precoUnitario: string }>): string {
  const centavos = itens.reduce((acc, i) => acc + i.quantidade * Math.round(Number(i.precoUnitario) * 100), 0);
  return (centavos / 100).toFixed(2);
}

servidor.adicionar(
  // ------------------------------------------------------------ contrato
  {
    metodo: 'POST',
    caminho: '/orcamentos',
    roles: ['SERVICO'],
    comando: 'billing.gerar-orcamento',
    handler: ({ body }) => {
      const existente = orcamentos.get(body.numeroOS);
      if (existente && existente.status !== 'CANCELADO') return { status: 200, body: corpoOrcamento(existente) };
      const o: Orcamento = {
        numeroOS: body.numeroOS,
        orcamentoId: `orc-${randomUUID()}`,
        clienteId: body.clienteId,
        total: total(body.itens),
        validoAte: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        status: 'PENDENTE',
        itens: body.itens,
        cobrancas: [],
        historico: [],
      };
      marcar(o, `orcamento gerado (R$ ${o.total})`);
      orcamentos.set(o.numeroOS, o);
      return { status: 201, body: corpoOrcamento(o) };
    },
  },
  {
    metodo: 'POST',
    caminho: '/orcamentos/{n}/cobrar',
    roles: ['SERVICO'],
    comando: 'billing.cobrar',
    handler: ({ params }) => {
      const o = orcamentos.get(params.n);
      if (!o) return naoEncontrada(params.n);
      if (o.status === 'PAGO') return conflito('pagamento ja aprovado');
      if (o.status !== 'APROVADO') return conflito(`orcamento nao aprovado (status ${o.status})`);
      const atual = ultimaCobranca(o);
      // idempotente: cobranca pendente e devolvida; depois de recusada, nova order (novo link)
      if (atual?.status === 'PENDENTE') return { status: 201, body: corpoCobranca(o, atual) };
      const orderId = `mp-${Date.now()}${++seqOrder}`;
      const c: Cobranca = { orderId, linkPagamento: `${LINK_BASE}/${orderId}`, valor: o.total, status: 'PENDENTE', criadaEm: new Date().toISOString() };
      o.cobrancas.push(c);
      marcar(o, `cobranca criada ${orderId}`);
      return { status: 201, body: corpoCobranca(o, c) };
    },
  },
  {
    metodo: 'DELETE',
    caminho: '/orcamentos/{n}',
    roles: ['SERVICO'],
    comando: 'billing.cancelar-orcamento',
    handler: ({ params, body }) => {
      const o = orcamentos.get(params.n);
      if (!o) return { status: 200, body: { numeroOS: params.n, orcamentoId: null, estornado: false } };
      if (o.status === 'PAGO') return conflito('pagamento ja aprovado');
      if (o.status !== 'CANCELADO') {
        o.status = 'CANCELADO';
        o.motivo = body.motivo;
        marcar(o, `orcamento cancelado (${body.motivo})`);
      }
      return { status: 200, body: { numeroOS: o.numeroOS, orcamentoId: o.orcamentoId, estornado: false } };
    },
  },

  // ------------------------------------------------------------ acoes do cliente
  {
    metodo: 'POST',
    caminho: '/orcamentos/{n}/aprovar',
    roles: ['CLIENTE', 'ADMIN'],
    handler: async ({ params, traceparent }) => {
      const o = orcamentos.get(params.n);
      if (!o) return naoEncontrada(params.n);
      if (o.status !== 'PENDENTE') return conflito(`orcamento nao esta pendente (status ${o.status})`);
      o.status = 'APROVADO';
      marcar(o, 'aprovado pelo cliente');
      const cb = await callbacks.enviar(o.numeroOS, 'billing.orcamento-aprovado', { orcamentoId: o.orcamentoId }, traceparent);
      return respostaDaAcao(o.numeroOS, o, cb);
    },
  },
  {
    metodo: 'POST',
    caminho: '/orcamentos/{n}/rejeitar',
    roles: ['CLIENTE', 'ADMIN'],
    handler: async ({ params, body, traceparent }) => {
      const o = orcamentos.get(params.n);
      if (!o) return naoEncontrada(params.n);
      if (o.status !== 'PENDENTE') return conflito(`orcamento nao esta pendente (status ${o.status})`);
      o.status = 'REJEITADO';
      o.motivo = body?.motivo;
      marcar(o, `rejeitado pelo cliente${o.motivo ? ` (${o.motivo})` : ''}`);
      const cb = await callbacks.enviar(
        o.numeroOS,
        'billing.orcamento-rejeitado',
        { orcamentoId: o.orcamentoId, ...(o.motivo ? { motivo: o.motivo } : {}) },
        traceparent,
      );
      return respostaDaAcao(o.numeroOS, o, cb);
    },
  },

  // ------------------------------------------------------------ Mercado Pago simulado + controle
  {
    metodo: 'POST',
    caminho: '/__stub/pagamentos/{n}',
    roles: null,
    handler: async ({ params, body, traceparent }) => {
      const o = orcamentos.get(params.n);
      if (!o) return naoEncontrada(params.n);
      const c = ultimaCobranca(o);
      if (!c || c.status !== 'PENDENTE') return conflito('nao ha cobranca pendente');
      const resultado: 'aprovado' | 'recusado' = body?.resultado ?? servidor.cenario.pagamento;
      if (resultado === 'aprovado') {
        c.status = 'APROVADA';
        o.status = 'PAGO';
        marcar(o, `pagamento aprovado ${c.orderId}`);
        const cb = await callbacks.enviar(o.numeroOS, 'billing.pagamento-aprovado', { orderId: c.orderId, valor: c.valor }, traceparent);
        return respostaDaAcao(o.numeroOS, o, cb);
      }
      const motivo = body?.motivo ?? servidor.cenario.motivoRecusaPagamento;
      // `cenario.pagamento: 'recusado'` vale para o PROXIMO pagamento: a nova cobranca e aprovada.
      if (!body?.resultado) servidor.cenario.pagamento = 'aprovado';
      c.status = 'RECUSADA';
      marcar(o, `pagamento recusado ${c.orderId} (${motivo})`);
      const cb = await callbacks.enviar(o.numeroOS, 'billing.pagamento-recusado', { orderId: c.orderId, motivo }, traceparent);
      return respostaDaAcao(o.numeroOS, o, cb);
    },
  },
  {
    metodo: 'GET',
    caminho: '/__stub/orcamentos/{n}',
    roles: null,
    handler: ({ params }) => {
      const o = orcamentos.get(params.n);
      return o ? { status: 200, body: o } : naoEncontrada(params.n);
    },
  },
  {
    metodo: 'POST',
    caminho: '/__stub/callbacks/{n}/reenviar',
    roles: null,
    handler: async ({ params, traceparent }) => {
      const cb = await callbacks.reenviarUltimo(params.n, traceparent);
      return cb ? respostaDaAcao(params.n, orcamentos.get(params.n), cb) : naoEncontrada(params.n);
    },
  },
);

servidor.ouvir(Number(process.env.PORT ?? 3001));
