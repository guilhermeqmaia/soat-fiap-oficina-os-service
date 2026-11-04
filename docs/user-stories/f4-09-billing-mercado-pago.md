# US-F4-09: Billing Service — Pagamento com Mercado Pago (Checkout + Webhook)

**User Story:** Como Cliente, quero pagar pelo Mercado Pago o servico ja executado (com o valor do orcamento que aprovei) e ter a OS finalizada automaticamente, para nao depender de conferencia manual.

**Prioridade:** Alta
**Story Points:** 8
**Status:** To Do
**DDD Domain:** Billing (Pagamento)
**DDD Layer:** Infrastructure (integracao externa) + Application
**Repositorio:** `soat-fiap-oficina-billing-service`
**Revisao 03/11/2026:** transporte HTTP ([RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md), contrato em [`docs/contratos/http-interno.md`](../contratos/http-interno.md)) — codigo do OS Service sera refatorado na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)

## Contexto

Obrigatorio no enunciado: integrar pagamentos com o Mercado Pago. Decisao
(ADR-0012, revisada em 03/11): **Checkout Pro via API de Orders** — o Billing
cria uma *order* (`POST /v1/orders`) e o cliente paga no checkout hospedado pelo
`checkout_url` da resposta; o Mercado Pago notifica por **webhook** (`type: order`).
A API de Preferences passou a ser tratada como legado pelo Mercado Pago e nao
deve ser usada. O sandbox tem cartoes de teste que produzem pagamento
aprovado/recusado/pendente de forma deterministica — perfeito para demonstrar o
pagamento pendente no video.

> **Momento da cobranca (decisao do time, 03/11/2026):** a cobranca acontece **depois da
> execucao**, nao na aprovacao do orcamento. `billing.orcamento-aprovado` nao cria order; a
> order so e criada quando o orquestrador chama `POST /orcamentos/{numeroOS}/cobrar` (apos
> `execucao.finalizada`, ≙ `billing.cobrar`) e a resposta `201` e o evento `billing.cobranca-criada`. Pagamento recusado nao
> cancela a OS (o servico ja foi feito): a saga registra pendencia e o reprocessamento
> reenvia `billing.cobrar`.

> **Pre-requisito pronto (03/11/2026):** aplicacao `oficina-billing-fiap` criada no painel do Mercado Pago com
> **API de Orders**; secrets `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY` e `MP_WEBHOOK_SECRET` (credenciais de teste e
> assinatura do webhook) ja gravados no repo `soat-fiap-oficina-billing-service` — o CD deve leva-los ao
> Secrets Manager/ConfigMap; nunca no codigo. Webhook de teste assinado so no evento **Order**; exemplo real do
> payload em [`docs/contratos/exemplos/`](../contratos/exemplos/README.md). Contas de teste (vendedor/comprador)
> ficam com o Guilherme.

## Criterios de Aceite

- [ ] Credenciais (access token de teste/producao) e assinatura secreta do webhook no **Secrets Manager** (e nos secrets do repo para o CI); nunca no repo
- [ ] Em **`POST /orcamentos/{numeroOS}/cobrar`** (SERVICO; ≙ `billing.cobrar`; nao na aprovacao do orcamento): cria order via `POST /v1/orders` (`type: online`, `processing_mode: manual`, `external_reference` = numero da OS, `total_amount`/`unit_price` como strings decimais, `payer.email`, `config.online.*_url`, `X-Idempotency-Key`) com o total do orcamento aprovado e persiste `Cobranca` (PENDENTE) com o `id` da order e o `checkout_url`; responde **`201 { numeroOS, orderId, linkPagamento, valor }`** (≙ `billing.cobranca-criada`); orcamento nao aprovado -> `409 { motivo }`. Repeticao da chamada (retry/reprocessamento) com cobranca PENDENTE valida devolve a mesma order (`201` idempotente); com order expirada/recusada cancela a anterior e cria uma nova. O webhook e o da aplicacao (painel), nao da order
- [ ] `POST /webhooks/mercadopago`: valida **`x-signature`** (`ts` + `v1`, HMAC com `x-request-id` e `data.id`) e responde 200/201; consulta `GET /v1/orders/{id}` (nunca confia so no payload); **idempotente** por **id da order**
- [ ] `order.processed` com pagamento aprovado -> callback `POST /ordens-servico/{numeroOS}/eventos` `type: billing.pagamento-aprovado` `{ numeroOS, orderId, valor }` (OS -> `FINALIZADA`); order recusada/cancelada -> callback `billing.pagamento-recusado` `{ numeroOS, orderId, motivo }` (OS permanece `AGUARDANDO_PAGAMENTO`); `order.action_required` / pagamento pendente -> mantem PENDENTE, sem callback. Callback com retry 3x; `409` do OS -> repetir; `id` do envelope e o `order_id` + evento (o OS deduplica)
- [ ] Reconciliacao: job que consulta por `GET /v1/orders/{id}` as cobrancas PENDENTES ha mais de X min (webhook perdido) — recuperacao para frente
- [ ] Sem estorno por compensacao (nada e pago antes da execucao; `billing.cancelar-orcamento` so chega antes da cobranca existir). Order ainda nao paga e cancelada nos endpoints de Orders quando uma nova cobranca e emitida ou a order expira
- [ ] Integracao com o SDK `mercadopago` 2.x (classe `Order`); testes com o SDK mockado + roteiro no QA Plan usando os cartoes de teste do sandbox (titular `APRO` aprova, `OTHE` recusa, `CONT` pendente)
- [ ] Logs mascaram dados do pagador
## APIs que expoe

| Metodo | Rota | Role | Corpo | Resposta |
|---|---|---|---|---|
| POST | `/orcamentos/{numeroOS}/cobrar` | SERVICO | — | `201 { numeroOS, orderId, linkPagamento, valor }` ≙ `billing.cobranca-criada` · `409 { motivo }` (orcamento nao aprovado) |
| POST | `/webhooks/mercadopago?type=order&data.id=<id>` | publico (gateway sem authorizer; valida `x-signature` + `x-request-id`) | notificacao `{ action: order.processed \| order.action_required, data: { id } }` | `200/201` sempre que a assinatura for valida (processa de forma idempotente por `order_id`) |
| GET | `/pagamentos/{numeroOS}` | CLIENTE (posse), ATENDENTE, ADMIN | — | `200 { orderId, status, linkPagamento, valor }` (link para a UI do cliente) |

## APIs que consome

| Metodo | Rota (servico) | Quando | Corpo | Resposta |
|---|---|---|---|---|
| POST | `https://api.mercadopago.com/v1/orders` (Mercado Pago) | em `cobrar` | `type: online`, `processing_mode: manual`, `external_reference` = numeroOS, `total_amount`, `items[]`, `payer.email`, `config.online.*_url`, header `X-Idempotency-Key` | `201 { id, status, checkout_url }` |
| GET | `https://api.mercadopago.com/v1/orders/{id}` (Mercado Pago) | ao receber webhook e na reconciliacao | — | `200` order (status do pagamento) |
| POST | `https://api.mercadopago.com/v1/orders/{id}/cancel` (Mercado Pago) | nova cobranca substitui order nao paga | — | `200` |
| POST | `/ordens-servico/{numeroOS}/eventos` (OS Service, interno) | pagamento aprovado / recusado | envelope `type: billing.pagamento-aprovado` `{ numeroOS, orderId, valor }` ou `billing.pagamento-recusado` `{ numeroOS, orderId, motivo }` | `200 { aplicado, passo, status }` · `409` repetir |

## O que salva no banco

Postgres **`oficina_billing`** (mesmas tabelas da [US-F4-08](f4-08-billing-orcamento.md)):

| Tabela | O que esta story grava |
|---|---|
| `cobranca` | `order_id` (Mercado Pago), `checkout_url`/`linkPagamento`, `valor`, status `PENDENTE` -> `APROVADA` / `RECUSADA` / `CANCELADA` / `EXPIRADA`, `idempotency_key`, `pago_em`, `ultima_consulta_em` (reconciliacao) |
| `ledger` | lancamentos append-only `COBRANCA_CRIADA`, `PAGAMENTO_APROVADO`, `PAGAMENTO_RECUSADO`, `COBRANCA_CANCELADA` (com `order_id`) |
| `webhook_mercado_pago` | `order_id`, `x-request-id`, `action`, payload bruto, `assinatura_valida`, `recebido_em` — idempotencia e auditoria do webhook |

Credenciais (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`) ficam no Secrets Manager, nunca no banco. Logs mascaram dados do pagador.

## Dependencias

- [US-F4-08](f4-08-billing-orcamento.md), [US-F4-05](f4-05-gateway-multi-servico.md)

## Referencias

- [ADR-0012](../arquitetura/adr/ADR-0012-pagamento-mercado-pago.md)
- Mercado Pago: [Checkout Pro (Orders) — criar order](https://docs02.mercadopago.com.br/developers/en/docs/checkout-pro-orders/create-order) · [Orders — notificacoes](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications) · [Checkout Pro (Orders) — notificacoes](https://www.mercadopago.com.mx/developers/pt/docs/checkout-pro-orders/notifications) · [SDK Node](https://github.com/mercadopago/sdk-nodejs) · cartoes de teste
