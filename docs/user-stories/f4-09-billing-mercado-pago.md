# US-F4-09: Billing Service — Pagamento com Mercado Pago (Checkout + Webhook)

**User Story:** Como Cliente, quero pagar o orcamento aprovado pelo Mercado Pago e ter a OS liberada para execucao automaticamente, para nao depender de conferencia manual.

**Prioridade:** Alta
**Story Points:** 8
**Status:** To Do
**DDD Domain:** Billing (Pagamento)
**DDD Layer:** Infrastructure (integracao externa) + Application
**Repositorio:** `soat-fiap-oficina-billing-service`

## Contexto

Obrigatorio no enunciado: integrar pagamentos com o Mercado Pago. Decisao
(ADR-0012, revisada em 03/11): **Checkout Pro via API de Orders** — o Billing
cria uma *order* (`POST /v1/orders`) e o cliente paga no checkout hospedado pelo
`checkout_pro.init_point`; o Mercado Pago notifica por **webhook** (`type: order`).
A API de Preferences passou a ser tratada como legado pelo Mercado Pago e nao
deve ser usada. O sandbox tem cartoes de teste que produzem pagamento
aprovado/recusado/pendente de forma deterministica — perfeito para demonstrar a
compensacao no video.

> **Pre-requisito pronto (03/11/2026):** aplicacao `oficina-billing-fiap` criada no painel do Mercado Pago com
> **API de Orders**; secrets `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY` e `MP_WEBHOOK_SECRET` (credenciais de teste e
> assinatura do webhook) ja gravados no repo `soat-fiap-oficina-billing-service` — o CD deve leva-los ao
> Secrets Manager/ConfigMap; nunca no codigo. Webhook de teste assinado so no evento **Order**; exemplo real do
> payload em [`docs/contratos/exemplos/`](../contratos/exemplos/README.md). Contas de teste (vendedor/comprador)
> ficam com o Guilherme.

## Criterios de Aceite

- [ ] Credenciais (access token de teste/producao) e assinatura secreta do webhook no **Secrets Manager** (e nos secrets do repo para o CI); nunca no repo
- [ ] Ao aprovar orcamento: cria order via `POST /v1/orders` (`type: online`, `processing_mode: automatic`, `external_reference` = numero da OS, `notification_url` = rota publica do gateway, `total_amount`, `items`, `payer`) e persiste `Cobranca` (PENDENTE) com o `id` da order e o `checkout_pro.init_point`
- [ ] `POST /webhooks/mercadopago`: valida **`x-signature`** (`ts` + `v1`, HMAC com `x-request-id` e `data.id`) e responde 200/201; consulta `GET /v1/orders/{id}` (nunca confia so no payload); **idempotente** por **id da order**
- [ ] `order.processed` com pagamento aprovado -> `billing.pagamento-aprovado` (com `orderId`); order recusada/cancelada -> `billing.pagamento-recusado`; `order.action_required` / pagamento pendente -> mantem PENDENTE
- [ ] Reconciliacao: job que consulta por `GET /v1/orders/{id}` as cobrancas PENDENTES ha mais de X min (webhook perdido) — recuperacao para frente
- [ ] Estorno pelos endpoints de Orders quando a compensacao exigir (`billing.cancelar-orcamento` com pagamento aprovado); order ainda nao paga e cancelada
- [ ] Integracao com o SDK `mercadopago` 2.x (classe `Order`); testes com o SDK mockado + roteiro no QA Plan usando os cartoes de teste do sandbox (titular `APRO` aprova, `OTHE` recusa, `CONT` pendente)
- [ ] Logs mascaram dados do pagador
## Dependencias

- [US-F4-08](f4-08-billing-orcamento.md), [US-F4-05](f4-05-gateway-multi-servico.md)

## Referencias

- [ADR-0012](../arquitetura/adr/ADR-0012-pagamento-mercado-pago.md)
- Mercado Pago: [Checkout Pro (Orders) — criar order](https://docs02.mercadopago.com.br/developers/en/docs/checkout-pro-orders/create-order) · [Orders — notificacoes](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications) · [Checkout Pro (Orders) — notificacoes](https://www.mercadopago.com.mx/developers/pt/docs/checkout-pro-orders/notifications) · [SDK Node](https://github.com/mercadopago/sdk-nodejs) · cartoes de teste
