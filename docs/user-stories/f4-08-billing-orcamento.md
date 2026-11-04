# US-F4-08: Billing Service — Orcamento, Aprovacao e Rejeicao

**User Story:** Como Cliente, quero receber o orcamento da minha OS e aprova-lo ou rejeita-lo num servico dedicado, para que a decisao dispare o pagamento ou o cancelamento com seguranca.

**Prioridade:** Alta
**Story Points:** 8
**Status:** To Do
**DDD Domain:** Billing (novo: Orcamento, Pagamento)
**DDD Layer:** Domain + Application + Infrastructure
**Repositorio:** novo — `soat-fiap-oficina-billing-service`
**Revisao 03/11/2026:** transporte HTTP ([RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md), contrato em [`docs/contratos/http-interno.md`](../contratos/http-interno.md)) — codigo do OS Service sera refatorado na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)

## Contexto

Enunciado: "geracao e envio de orcamentos para aprovacao; registro e
verificacao de pagamentos; atualizacao do status da OS apos pagamento". Banco
**SQL (Postgres)** — dinheiro exige ACID e um ledger auditavel (licao do Nubank:
nunca corrigir saldo "so na memoria da maquina").

Desde 03/11 (RFC-0008) o Billing e uma **API REST comum**: os comandos do
orquestrador chegam como endpoints HTTP (JWT `SERVICO`) e as decisoes do cliente
geram **callbacks** `POST /ordens-servico/{numeroOS}/eventos` no OS Service.

## Criterios de Aceite

- [ ] `POST /orcamentos` (SERVICO; ≙ `billing.gerar-orcamento`, itens com precos congelados) -> cria `Orcamento` (itens, subtotal, total, validade) -> `201 { numeroOS, orcamentoId, total, validoAte }` (≙ `billing.orcamento-gerado`); ja existe orcamento ativo para a OS -> `200` com o existente (idempotente por `numeroOS`)
- [ ] `GET /orcamentos/{numeroOS}` (e `GET /orcamentos?clienteId=`) com posse por CPF (claim) para CLIENTE; staff le qualquer um
- [ ] `POST /orcamentos/{numeroOS}/aprovar` (CLIENTE, via gateway) -> callback `billing.orcamento-aprovado` `{ numeroOS, orcamentoId }` no OS Service (**sem** cobranca: a order so e criada em `POST /orcamentos/{numeroOS}/cobrar`, apos a execucao — [US-F4-09](f4-09-billing-mercado-pago.md))
- [ ] `POST /orcamentos/{numeroOS}/rejeitar` (CLIENTE) -> callback `billing.orcamento-rejeitado` `{ numeroOS, orcamentoId, motivo? }`
- [ ] `DELETE /orcamentos/{numeroOS}` (SERVICO; ≙ `billing.cancelar-orcamento`, compensacao so antes da execucao) -> cancela orcamento -> `200 { numeroOS, orcamentoId, estornado: false }` (≙ `billing.orcamento-cancelado`; idempotente)
- [ ] Orcamento e imutavel apos aprovado; nova versao exige novo diagnostico
- [ ] Tabela `ledger` append-only com todo lancamento (orcamento, cobranca, pagamento)
- [ ] Callbacks ao OS via cliente HTTP do kit (JWT `SERVICO`, retry 3x, correlacao); `409` do OS -> reler e repetir
- [ ] Testes >= 80%; Swagger (OpenAPI versionado no hub, [US-F4-15](f4-15-testes-de-contrato.md))
## APIs que expoe

Conforme [`http-interno.md`](../contratos/http-interno.md). Prefixos `/orcamentos|/pagamentos|/webhooks` atras do API Gateway; rotas `SERVICO` chamadas pelo OS Service pelo DNS interno (`http://billing-service:3001`).

| Metodo | Rota | Role | Corpo | Resposta |
|---|---|---|---|---|
| POST | `/orcamentos` | SERVICO | `{ numeroOS, clienteId, itens[] }` | `201 { numeroOS, orcamentoId, total, validoAte }` ≙ `billing.orcamento-gerado` · `200` com o existente se ja ha orcamento ativo |
| POST | `/orcamentos/{numeroOS}/cobrar` | SERVICO | — | `201 { numeroOS, orderId, linkPagamento, valor }` ≙ `billing.cobranca-criada` · `409 { motivo }` orcamento nao aprovado ([US-F4-09](f4-09-billing-mercado-pago.md)) |
| DELETE | `/orcamentos/{numeroOS}` | SERVICO | `{ motivo }` | `200 { numeroOS, orcamentoId, estornado }` ≙ `billing.orcamento-cancelado` (idempotente) |
| POST | `/orcamentos/{numeroOS}/aprovar` | CLIENTE (posse por CPF) | — | `200` orcamento `APROVADO`; dispara callback `billing.orcamento-aprovado` |
| POST | `/orcamentos/{numeroOS}/rejeitar` | CLIENTE | `{ motivo? }` | `200` orcamento `REJEITADO`; dispara callback `billing.orcamento-rejeitado` |
| GET | `/orcamentos/{numeroOS}` · `/orcamentos?clienteId=` | CLIENTE (posse), ATENDENTE, ADMIN | — | `200` orcamento (itens, total, validade, status, cobranca) |
| POST | `/webhooks/mercadopago` | publico (assinatura `x-signature`) | notificacao `order` | `200/201` ([US-F4-09](f4-09-billing-mercado-pago.md)) |
| GET | `/health` · `/metrics` · `/api` (Swagger) | interno | — | kit |

## APIs que consome

| Metodo | Rota (servico) | Quando | Corpo (envelope) | Resposta |
|---|---|---|---|---|
| POST | `/ordens-servico/{numeroOS}/eventos` (OS Service, `http://os-service:3000`) | cliente aprova | `type: billing.orcamento-aprovado`, `data: { numeroOS, orcamentoId }` | `200 { aplicado, passo, status }` · `409` repetir · `404` |
| POST | `/ordens-servico/{numeroOS}/eventos` (OS Service) | cliente rejeita | `type: billing.orcamento-rejeitado`, `data: { numeroOS, orcamentoId, motivo? }` | idem |
| POST | `/ordens-servico/{numeroOS}/eventos` (OS Service) | webhook do Mercado Pago | `type: billing.pagamento-aprovado` / `billing.pagamento-recusado` | idem ([US-F4-09](f4-09-billing-mercado-pago.md)) |
| POST/GET | `https://api.mercadopago.com/v1/orders`, `/v1/orders/{id}` | cobrar / reconciliar | order | [US-F4-09](f4-09-billing-mercado-pago.md) |

JWT `SERVICO` (`sub: billing-service`) via `mintServiceToken`; retry 3x; `x-correlation-id` = `numeroOS`. Nao chama a Execucao nem a Lambda.

## O que salva no banco

Postgres **`oficina_billing`** (usuario exclusivo; nenhum outro servico acessa):

| Tabela | O que guarda |
|---|---|
| `orcamento` | `numero_os`, `cliente_id`, **itens recebidos** (snapshot: tipo, referencia, nome, quantidade, preco unitario congelado), `subtotal`, `total`, `valido_ate`, status (`PENDENTE`, `APROVADO`, `REJEITADO`, `CANCELADO`, `EXPIRADO`), **decisao do cliente** (`decidido_em`, `motivo_rejeicao`), `version` |
| `orcamento_item` | linhas do orcamento (imutaveis apos aprovacao) |
| `cobranca` | `orcamento_id`, `numero_os`, **`order_id` do Mercado Pago**, **`checkout_url`/`linkPagamento`**, `valor`, status (`PENDENTE`, `APROVADA`, `RECUSADA`, `CANCELADA`, `EXPIRADA`), `idempotency_key`, timestamps ([US-F4-09](f4-09-billing-mercado-pago.md)) |
| `ledger` | **append-only**: um lancamento por fato financeiro (`ORCAMENTO_GERADO`, `ORCAMENTO_APROVADO`, `ORCAMENTO_CANCELADO`, `COBRANCA_CRIADA`, `PAGAMENTO_APROVADO`, `PAGAMENTO_RECUSADO`) com valor, referencia (`orcamento_id`/`order_id`) e `ocorrido_em` — nunca editado |
| `webhook_mercado_pago` | `order_id`, `x-request-id`, payload bruto, `recebido_em` (idempotencia do webhook por id da order) |

Sem `outbox` nem `processed_messages`: comandos sao idempotentes por `numero_os` (unique em `orcamento` ativo) e o webhook por `order_id`.

## Dependencias

- [US-F4-01](f4-01-kit-compartilhado.md), [US-F4-18](f4-18-comunicacao-http-entre-servicos.md) (kit `/http`, `Role.SERVICO`), [US-F4-03](f4-03-bancos-por-servico.md)
