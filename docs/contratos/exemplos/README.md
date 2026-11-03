# Exemplos de payloads externos

## Mercado Pago — webhook `order.processed`

`mercado-pago-webhook-order.processed.json` e o corpo entregue pelo botao
**Simular notificacao** do painel do Mercado Pago (aplicacao `oficina-billing-fiap`,
modo teste, evento **Order**), capturado em 03/11/2026 via webhook.site.

O que o handler `POST /webhooks/mercadopago` do Billing (US-F4-09) precisa saber:

- A requisicao e um `POST` com **query string** `type=order&data_id=<id da order>` e
  cabecalhos `x-signature` (`ts=...,v1=...`) e `x-request-id`. A validacao da
  assinatura usa `data.id`, `x-request-id` e `ts` com a assinatura secreta do painel.
- `type` = `order`; `action` = `order.processed` (pago) ou `order.action_required`.
- `data.id` = id da order (chave de idempotencia e do fallback `GET /v1/orders/{id}`).
- `data.external_reference` = numero da OS que o Billing informou ao criar a order.
- `data.status` / `data.status_detail` (`processed` + `accredited` = aprovado) e
  `data.transactions.payments[]` com o pagamento e o meio usado.
- Na simulacao `data.type` vem `point` e os valores vem como inteiros (`100000`);
  numa order online real espera-se `type: "online"` e valores conforme a API de
  Orders — **confirmar com uma order real no sandbox antes de fixar o parser**.
- Nunca confiar so no payload: consultar `GET /v1/orders/{id}` antes de publicar
  `billing.pagamento-aprovado` / `billing.pagamento-recusado`.
