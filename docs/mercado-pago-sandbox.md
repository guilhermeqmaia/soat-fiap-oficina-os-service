# Mercado Pago — sandbox, orders de teste e webhook local

Runbook para quem for implementar/testar a US-F4-09 (Billing). Tudo aqui usa o
**modo teste** da aplicacao `oficina-billing-fiap` (API de Orders, ADR-0012).

## 1. O que ja esta pronto (03/11/2026)

| Item | Onde |
|---|---|
| Aplicacao `oficina-billing-fiap` (Checkout Pro, API de Orders) | painel do Mercado Pago, conta do Guilherme |
| Access Token / Public Key de teste | secrets `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY` do repo `soat-fiap-oficina-billing-service` |
| Assinatura secreta do webhook | secret `MP_WEBHOOK_SECRET` do mesmo repo |
| Webhook de teste (evento **Order**) | apontando para um endpoint do webhook.site ate o Billing existir |
| Exemplo real de `order.processed` | [`contratos/exemplos/`](contratos/exemplos/README.md) |
| Contas de teste vendedor/comprador | Guilherme (login fora do repo) |

Para rodar localmente, peca ao Guilherme os valores pelo cofre do time e coloque no
`.env` do Billing (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`). Nunca comite.

## 2. Criar uma order no sandbox (e a API real; nao ha mock)

```bash
curl -s -X POST https://api.mercadopago.com/v1/orders \
  -H "Authorization: Bearer $MP_ACCESS_TOKEN" \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "online",
    "processing_mode": "manual",
    "external_reference": "OS-2026-0001",
    "total_amount": "300.00",
    "expiration_time": "P1D",
    "payer": { "email": "test_user_<comprador>@testuser.com" },
    "items": [
      { "title": "Troca de pastilha", "quantity": 1, "unit_price": "200.00" },
      { "title": "Pastilha dianteira", "quantity": 2, "unit_price": "50.00" }
    ],
    "config": { "online": {
      "success_url": "https://exemplo.com/pago",
      "failure_url": "https://exemplo.com/falhou",
      "pending_url": "https://exemplo.com/pendente",
      "auto_return": "approved"
    } }
  }'
```

Regras que a API aplica: `total_amount` = soma de `quantity × unit_price`; valores
sao **strings com 2 casas**; `processing_mode` so aceita `manual` no Checkout Pro;
`external_reference` ate 64 caracteres (use o numero da OS). A resposta (201) traz
`id` (`ORD...`), `status: "created"` e **`checkout_url`** — e esse link que vai
em `billing.cobranca-criada.linkPagamento` (a order e criada ao receber `billing.cobrar`,
depois da execucao do servico — ADR-0012; `billing.orcamento-aprovado` nao tem link).

No Billing, o mesmo com o SDK: `new Order(new MercadoPagoConfig({ accessToken })).create({ body, requestOptions: { idempotencyKey } })`.

## 3. Pagar a order (gera o webhook de verdade)

1. Janela anonima, logado com a **conta de teste compradora**.
2. Abra o `checkout_url`.
3. Cartao de teste (Mastercard `5480 8328 0103 3311`, venc. `11/30`, CVV `123`,
   documento `12345678909`) e o **nome do titular decide o resultado**:
   `APRO` aprovado · `OTHE` recusado · `CONT` pendente.
4. O Mercado Pago envia `POST <url-do-webhook>?type=order&data.id=<id>` com
   `action: order.processed` (ou `order.action_required`). Enquanto a URL for o
   webhook.site, o payload aparece la; depois, no Billing.

Consultar o estado a qualquer momento (reconciliacao):

```bash
curl -s https://api.mercadopago.com/v1/orders/$ORDER_ID -H "Authorization: Bearer $MP_ACCESS_TOKEN"
```

## 4. Simular o webhook contra o Billing local

O Mercado Pago nao alcanca `localhost`. Tres caminhos:

- **Botao "Simular notificacao"** no painel (Configuracao de webhooks): envia um
  `order.processed` sintetico para a URL de teste. Serve para validar assinatura e parse.
- **Tunel** (`cloudflared tunnel --url http://localhost:3001` ou ngrok): troque a
  URL de teste do painel pela URL do tunel + `/webhooks/mercadopago` e pague uma
  order de verdade (item 3). Melhor forma de ver o fluxo completo.
- **Replay local assinado** do exemplo em `contratos/exemplos/`, com a assinatura
  calculada do mesmo jeito que o Mercado Pago:

```bash
# manifest usado pelo Mercado Pago (mesmo do validador do SDK):
#   id:<data.id>;request-id:<x-request-id>;ts:<ts>;   -> HMAC-SHA256 com a assinatura secreta -> v1
ID=123; RID=$(uuidgen); TS=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
V1=$(printf 'id:%s;request-id:%s;ts:%s;' "$ID" "$RID" "$TS" | openssl dgst -sha256 -hmac "$MP_WEBHOOK_SECRET" | awk '{print $NF}')
curl -s -X POST "http://localhost:3001/webhooks/mercadopago?type=order&data.id=$ID" \
  -H "x-signature: ts=$TS,v1=$V1" -H "x-request-id: $RID" -H "Content-Type: application/json" \
  --data-binary @docs/contratos/exemplos/mercado-pago-webhook-order.processed.json -w '\n%{http_code}\n'
```

Atencao: `data.id` no manifest e o valor da **query string** (`data.id`), em
minusculas se for alfanumerico. O handler deve responder 200/201 em ate 22 s
(senao o Mercado Pago reenvia a cada 15 min), validar a assinatura, e **consultar
`GET /v1/orders/{id}`** antes de enviar o callback `billing.pagamento-aprovado` /
`billing.pagamento-recusado` ao OS Service (`POST /ordens-servico/{numeroOS}/eventos`,
JWT `SERVICO`, retry 3x — RFC-0008). Idempotencia por id da order.

## 5. Cenarios para o BDD / video

| Cenario | Como provocar | Resultado esperado |
|---|---|---|
| Cobranca criada | callback `execucao.finalizada` → OS chama `POST /orcamentos/{n}/cobrar` (≙ `billing.cobrar`) | Billing cria a order e responde `201 { orderId, linkPagamento, valor }` (≙ `billing.cobranca-criada`; link ao cliente); OS `AGUARDANDO_PAGAMENTO` |
| Pagamento aprovado | titular `APRO` | `order.processed` → callback `billing.pagamento-aprovado` → OS `FINALIZADA`; atendente entrega |
| Pagamento recusado | titular `OTHE` | callback `billing.pagamento-recusado` → **sem compensacao** (servico ja executado): OS segue `AGUARDANDO_PAGAMENTO`, saga registra `pagamento-pendente`; `POST /admin/sagas/:numero/reprocessar` repete `POST /orcamentos/{n}/cobrar` (nova order) — runbook `docs/runbooks/saga-reprocessar.md` |
| Pagamento pendente | titular `CONT` | cobranca segue PENDENTE; reconciliacao consulta a order |
| Webhook perdido | pagar com a URL do webhook apontando para lugar nenhum | job de reconciliacao (`GET /v1/orders/{id}`) fecha a cobranca |
| Pagamento em atraso | nao pagar; `SAGA_TIMEOUT_PAGAMENTO_MS` curto no OS Service | OS **nao** e cancelada: historico `pagamento em atraso`, `oficina_os_sagas_paradas` alerta; `TIMEOUT_PAGAMENTO` e reservado/obsoleto |

## 6. Quando o Billing subir na AWS

Trocar a URL do webhook (modo **producao** da aplicacao continua sem uso; so o
modo teste) para `https://<api-id>.execute-api.us-east-1.amazonaws.com/webhooks/mercadopago`
— rota publica do gateway (US-F4-05) — e mover os tres secrets para o Secrets
Manager que o CD do Billing sincroniza.
