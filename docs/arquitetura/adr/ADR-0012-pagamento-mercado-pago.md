# ADR-0012: Pagamento com Mercado Pago (Checkout Pro + webhook)

**Status:** Aceita
**Data:** 2026-09-30 (revisada em 2026-11-03)

## Contexto

O enunciado torna obrigatória a integração de pagamentos com o **Mercado Pago**
no Billing. É preciso decidir o produto de checkout, **quando** o pagamento
acontece no ciclo da OS e como o resultado chega ao sistema. Uber (pagamentos):
ordens **imutáveis**, idempotência por ID, "retries exponenciais por longos
períodos" como base de um pagamento confiável.

Em 03/11/2026, ao criar a aplicação no painel do Mercado Pago, constatou-se que
a **API de Preferences** (modelo original desta ADR) passou a ser tratada como
**legado** pelo Mercado Pago; o Checkout Pro é oferecido sobre a **API de Orders**
(`/v1/orders`). A decisão de produto (Checkout Pro + webhook) não muda; muda o
recurso de integração.

## Decisão

- **Checkout Pro via API de Orders**: o Billing cria uma *order*
  (`POST /v1/orders` com `type: "online"`, `processing_mode: "automatic"`,
  `external_reference` = número da OS, `notification_url` = rota pública do
  gateway, `total_amount`, `items`, `payer`) e devolve o `checkout_pro.init_point`
  da resposta; o cliente paga no checkout hospedado — nenhum dado de cartão passa
  pelo nosso sistema. O `id` da order é a chave externa da `Cobranca`.
- **Momento:** o pagamento acontece **na aprovação do orçamento** — novo status
  **`AGUARDANDO_PAGAMENTO`** entre `AGUARDANDO_APROVACAO` e `EM_EXECUCAO`. A
  execução só começa com pagamento aprovado (é o que torna a compensação
  "pagamento recusado → liberar reservas → cancelar" demonstrável).
- **Webhook** `POST /webhooks/mercadopago` público no gateway (sem JWT), validado
  no Billing pelo cabeçalho **`x-signature`** (`ts` + `v1`, HMAC com a assinatura
  secreta do painel, calculado sobre `x-request-id` e `data.id`; os SDKs oficiais
  têm helper de validação). A notificação chega com `type: "order"`, `action`
  `order.processed` / `order.action_required` e `data.id` = id da order; o Billing
  responde 200/201 e **sempre consulta** `GET /v1/orders/{id}` antes de agir;
  idempotente por **id da order**.
- **Reconciliação:** job periódico consulta por `GET /v1/orders/{id}` as cobranças
  `PENDENTE` há mais de 15 min (webhook perdido) — recuperação para frente.
- **Estorno/cancelamento** pelos endpoints de Orders quando a compensação exigir
  (reembolso da order paga; cancelamento da order ainda não paga); **ledger**
  append-only registra orçamento, cobrança, pagamento e estorno (nunca se edita
  um lançamento).
- **SDK:** `mercadopago` 2.x para Node, classe `Order` (`order.create`).
- Credenciais (access token, assinatura secreta do webhook) no **Secrets Manager**;
  credenciais de teste, contas de teste e cartões de teste (titular `APRO`
  aprova, `OTHE` recusa, `CONT` pendente) para demo e BDD; **WireMock** simula o
  Mercado Pago no compose.

## Alternativas rejeitadas

- **API de Preferences** (`POST /checkout/preferences`, webhook `type: payment`,
  idempotência por `payment.id`) — era o modelo original desta ADR; rejeitada em
  03/11/2026 porque o Mercado Pago passou a tratá-la como **legado** e aponta a
  API de Orders como caminho para o Checkout Pro. Entrar na Fase 4 em cima de um
  recurso legado significaria migrar em seguida.
- **Checkout Transparente / Bricks** — exigiria tratar dados de cartão (ou
  tokenização) no nosso front; mais superfície de segurança sem ganho didático.

## Consequências

- Máquina de estados da OS ganha um status; UIs `admin`/`cliente` mostram o link de pagamento.
- A notificação "orçamento aprovado" passa a carregar o link de pagamento (`checkout_pro.init_point`).
- O evento `billing.pagamento-aprovado` carrega o `orderId` (id da order) no lugar
  de um `payment.id`; o OS Service apenas repassa esse valor.
- Ambiente efêmero precisa da URL pública do gateway configurada na order
  (`notification_url`); o job de reconciliação cobre a janela em que o webhook não
  alcança o ambiente.
- Custos: sandbox gratuito; em produção real haveria taxa por transação (fora do escopo acadêmico).

## Histórico

- 2026-09-30: aceita (Checkout Pro via API de Preferences).
- 2026-11-03: revisada de Preferences para Orders — Preferences passou a ser
  tratada como legado pelo Mercado Pago. Aplicação `oficina-billing-fiap` criada
  no painel com a API de Orders.

## Referências

- [Checkout Pro (Orders) — criar order](https://docs02.mercadopago.com.br/developers/en/docs/checkout-pro-orders/create-order)
- [Orders — notificações (webhook)](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications) · [Checkout Pro (Orders) — notificações](https://www.mercadopago.com.mx/developers/pt/docs/checkout-pro-orders/notifications)
- [SDK Node `mercadopago`](https://github.com/mercadopago/sdk-nodejs)
