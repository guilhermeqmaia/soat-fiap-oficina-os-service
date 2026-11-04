# US-F4-12: Notificacoes ao Cliente a partir dos Eventos

**User Story:** Como Cliente, quero continuar sendo avisado quando o orcamento ficar pronto, o pagamento for confirmado e a OS for finalizada, para acompanhar minha OS mesmo com o sistema distribuido.

**Prioridade:** Media
**Story Points:** 3
**Status:** To Do
**DDD Domain:** Notificacao
**DDD Layer:** Application (listener in-process alimentado pelos callbacks) + Infrastructure
**Repositorio:** OS Service (modulo `notificacao`)
**Revisao 03/11/2026:** transporte HTTP ([RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md), contrato em [`docs/contratos/http-interno.md`](../contratos/http-interno.md)) — codigo do OS Service sera refatorado na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)

## Contexto

O modulo de Notificacao da Fase 2 ja e um consumidor de eventos. Com a RFC-0008
(03/11) ele continua **in-process** no OS Service: os fatos dos outros servicos
chegam pelos callbacks `POST /ordens-servico/{numero}/eventos` e, depois do commit
da saga, sao republicados no `EventEmitter` local; os fatos da propria OS
(`finalizada`, `cancelada`) continuam vindo das transicoes. Um bom exemplo de
coreografia dentro de uma arquitetura orquestrada: a notificacao apenas assina fatos.

## Criterios de Aceite

- [ ] Listener in-process reage a `billing.orcamento-gerado` (resposta de `POST /orcamentos`), `billing.orcamento-aprovado`, `billing.cobranca-criada` (resposta de `POST /orcamentos/{n}/cobrar`), `billing.pagamento-aprovado`, `billing.pagamento-recusado` (callbacks) e as transicoes locais `FINALIZADA`/`CANCELADA` — sem fila
- [ ] Mensagens com o **link de pagamento** quando houver — o link (`linkPagamento`) vem na resposta `201` de `POST /orcamentos/{n}/cobrar` ≙ `billing.cobranca-criada` (cobranca criada apos a execucao, ADR-0012), nao em `billing.orcamento-aprovado`
- [ ] Canais mantidos: webhook (HMAC) e e-mail; `GET /clientes/:cpf/notificacoes` inalterado
- [ ] Idempotente: uma notificacao por `id` do envelope — a dedup do callback em `processed_messages` garante que um callback repetido nao notifica de novo; chamadas sincronas repetidas (retry) tambem nao, porque o evento so e emitido quando a saga avanca
## APIs que expoe

| Metodo | Rota | Role | Corpo | Resposta |
|---|---|---|---|---|
| GET | `/clientes/:cpfCnpj/notificacoes` | CLIENTE (posse via claim) | — | `200` notificacoes do cliente (tipo, mensagem, `linkPagamento?`, canal, status, data) — inalterado |
| GET | `/notificacoes` | ADMIN, ATENDENTE | — | `200` todas (operacao) |
| — | webhook outbound para a URL do cliente (`NOTIFICACAO_WEBHOOK_URL`, assinatura HMAC) | — | `{ numeroOS, tipo, mensagem, linkPagamento? }` | espera `2xx`; retry simples |

## APIs que consome

| Metodo | Rota (servico) | Quando | Corpo | Resposta |
|---|---|---|---|---|
| POST | webhook do cliente (HMAC, Fase 2) | cada notificacao | payload acima | `2xx` |
| POST | Brevo / Ethereal (e-mail, `docs/notificacao-email.md`) | cada notificacao | e-mail com link quando houver | `2xx` |

Nao chama Billing nem Execucao: os fatos chegam ao OS Service pelos callbacks/respostas HTTP da saga e sao repassados in-process. Fontes dos fatos: `billing.orcamento-gerado` (orcamento pronto), `billing.orcamento-aprovado`, `billing.cobranca-criada` (link de pagamento), `billing.pagamento-aprovado`, `billing.pagamento-recusado`, transicoes `FINALIZADA`/`CANCELADA` da OS.

## O que salva no banco

Postgres **`oficina_os`**:

| Tabela | O que esta story grava |
|---|---|
| `notificacao` | `numero_os`, `cliente_id`, `tipo` (`ORCAMENTO_PRONTO`, `ORCAMENTO_APROVADO`, `PAGAMENTO_PENDENTE` com `link_pagamento`, `PAGAMENTO_APROVADO`, `PAGAMENTO_RECUSADO`, `OS_FINALIZADA`, `OS_CANCELADA`), `mensagem`, `canal` (e-mail/webhook), `status` (enviada/falhou), `evento_id` (= `id` do envelope que originou; unique por tipo+OS para nao duplicar), `criado_em` |

Nenhuma tabela nova; `processed_messages` (dedup dos callbacks) e compartilhada com a saga.

## Dependencias

- [US-F4-06](f4-06-os-service-strangler.md)

## Atencao (review da US-F4-06/10, 21/10; atualizado em 03/11)

O OS Service ja notifica **in-process** (`OrdemDeServicoNotificacaoListener`: `OrcamentoProntoEvent`,
`OsFinalizadaEvent`, `OsStatusAlteradoEvent`). Com a RFC-0008 **nao ha fila para ligar**: a story passa a ser
(1) emitir os eventos `billing.*` recebidos por HTTP (resposta sincrona ou callback) no `EventEmitter` apos o
commit, (2) incluir o `linkPagamento` de `billing.cobranca-criada` na mensagem "servico concluido, pague para
retirar o veiculo" (a mensagem de orcamento aprovado nao tem link) e (3) garantir uma notificacao por fato
(dedup por `id` do envelope). A fila `notificacao-eventos` e os eventos `os.*` publicados sao removidos na US-F4-18.
