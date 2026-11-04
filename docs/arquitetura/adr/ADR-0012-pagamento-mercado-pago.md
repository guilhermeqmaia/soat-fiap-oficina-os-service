# ADR-0012: Pagamento com Mercado Pago (Checkout Pro + webhook)

**Status:** Aceita
**Data:** 2026-09-30 (revisada em 2026-11-03: Orders; momento do pagamento)

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
  (`POST /v1/orders` com `type: "online"`, `processing_mode: "manual"` — único
  valor aceito no Checkout Pro —, `external_reference` = número da OS,
  `total_amount` e `items[].unit_price` como **strings decimais**, `payer.email`,
  `config.online.{success_url,failure_url,pending_url}`, `expiration_time`) e
  devolve o **`checkout_url`** da resposta; o cliente paga no checkout hospedado —
  nenhum dado de cartão passa pelo nosso sistema. O `id` da order é a chave externa
  da `Cobranca`. Não há `notification_url` por order: o webhook é o da **aplicação**
  (painel → Configuração de webhooks, evento **Order**), um por ambiente.
- **Momento:** o pagamento acontece **depois da execução do serviço** —
  `EM_EXECUCAO → AGUARDANDO_PAGAMENTO → FINALIZADA`. A aprovação do orçamento
  (`billing.orcamento-aprovado`) apenas libera a execução; ao receber
  `execucao.finalizada` o orquestrador envia o comando **`billing.cobrar`**, o
  Billing cria a order com o total do orçamento aprovado e publica
  **`billing.cobranca-criada`** (link de pagamento para a Notificação). Com
  `billing.pagamento-aprovado` a OS vai para `FINALIZADA`; o veículo **só é
  entregue** (`ENTREGUE`) depois do pagamento.
- **Sem estorno por compensação:** nada é pago antes de executar, então as
  compensações da saga (orçamento rejeitado, timeout de aprovação, falha ao
  iniciar a execução, cancelamento manual) nunca precisam reembolsar — apenas
  cancelam o orçamento e liberam reservas.
- **Inadimplência:** pagamento recusado ou em atraso **não cancela** a OS (o
  serviço já foi feito). A OS fica retida em `AGUARDANDO_PAGAMENTO`, a saga
  registra `pagamento-pendente` e a gauge `oficina_os_sagas_paradas` dispara o
  alerta; `POST /admin/sagas/:numero/reprocessar` reenvia `billing.cobrar`
  (nova order). O motivo `TIMEOUT_PAGAMENTO` fica reservado/obsoleto.
- **Webhook** `POST /webhooks/mercadopago` público no gateway (sem JWT), validado
  no Billing pelo cabeçalho **`x-signature`** (`ts` + `v1`, HMAC com a assinatura
  secreta do painel, calculado sobre `x-request-id` e `data.id`; os SDKs oficiais
  têm helper de validação). A notificação chega com `type: "order"`, `action`
  `order.processed` / `order.action_required` e `data.id` = id da order; o Billing
  responde 200/201 e **sempre consulta** `GET /v1/orders/{id}` antes de agir;
  idempotente por **id da order**.
- **Reconciliação:** job periódico consulta por `GET /v1/orders/{id}` as cobranças
  `PENDENTE` há mais de 15 min (webhook perdido) — recuperação para frente.
- **Cancelamento da order** pelos endpoints de Orders quando uma nova cobrança
  é emitida (reprocessamento) ou a order expira; **ledger** append-only registra
  orçamento, cobrança e pagamento (nunca se edita um lançamento). Reembolso fica
  fora do fluxo da saga (só por operação manual).
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
- **Pagar na aprovação do orçamento** (`AGUARDANDO_PAGAMENTO` antes de
  `EM_EXECUCAO`, modelo desta ADR até 03/11/2026) — tornava a compensação
  "pagamento recusado → estorno → cancelar" demonstrável, mas cobrava o cliente
  por um serviço ainda não realizado e exigia estorno em várias compensações.
  Rejeitada em 03/11/2026: o time preferiu cobrar só pelo serviço efetivamente
  realizado.

## Consequências

- Máquina de estados da OS ganha um status (`AGUARDANDO_PAGAMENTO`, entre
  `EM_EXECUCAO` e `FINALIZADA`); UIs `admin`/`cliente` mostram o link de pagamento.
- A notificação de "cobrança criada" (`billing.cobranca-criada`) carrega o link de
  pagamento (`checkout_url` da order); a de "orçamento aprovado" não tem link.
- A saga não tem compensação para falha de pagamento: pagamento recusado/em atraso
  é pendência operacional (OS retida, alerta, nova cobrança por reprocessamento).
- O evento `billing.pagamento-aprovado` carrega o `orderId` (id da order) no lugar
  de um `payment.id`; o OS Service apenas repassa esse valor.
- O webhook é configurado por aplicação no painel (não por order): a URL pública
  do gateway entra lá; enquanto o ambiente não existe, o job de reconciliação
  (`GET /v1/orders/{id}`) cobre a janela em que o webhook não alcança o Billing.
- Custos: sandbox gratuito; em produção real haveria taxa por transação (fora do escopo acadêmico).

## Histórico

- 2026-09-30: aceita (Checkout Pro via API de Preferences).
- 2026-11-03: revisada de Preferences para Orders — Preferences passou a ser
  tratada como legado pelo Mercado Pago. Aplicação `oficina-billing-fiap` criada
  no painel com a API de Orders.
- 2026-11-03: momento do pagamento movido da aprovação para após a execução
  (decisão do time). Novos `billing.cobrar` / `billing.cobranca-criada`;
  `billing.orcamento-aprovado` sem cobrança.

## Referências

- [Checkout Pro (Orders) — criar order](https://docs02.mercadopago.com.br/developers/en/docs/checkout-pro-orders/create-order)
- [Orders — notificações (webhook)](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications) · [Checkout Pro (Orders) — notificações](https://www.mercadopago.com.mx/developers/pt/docs/checkout-pro-orders/notifications)
- [SDK Node `mercadopago`](https://github.com/mercadopago/sdk-nodejs)
