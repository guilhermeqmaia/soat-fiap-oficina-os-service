# US-F4-18: Comunicacao HTTP entre Servicos (kit, OS Service, Billing, Execucao, infra)

**User Story:** Como Desenvolvedor de qualquer um dos tres servicos, quero que o orquestrador chame a Execucao e o Billing por HTTP com retry e que eles avisem o OS Service por callbacks HTTP autenticados, para que os servicos se integrem sem broker, outbox, DLQ ou LocalStack e o fluxo seja depuravel com `curl`, logs e traces.

**Prioridade:** Alta
**Story Points:** 8
**Status:** To Do (criada em 03/11/2026; substitui a [US-F4-02](f4-02-mensageria.md), cancelada). QA: [QA_PLAN_US-F4-18](../qa-plans/QA_PLAN_US-F4-18.md)
**DDD Domain:** Transversal (integracao entre bounded contexts)
**DDD Layer:** Infrastructure (kit, clientes HTTP, controllers de callback, Terraform)
**Repositorio:** kit (7) + os-service (4) + billing-service (5) + execucao-service (6) + infra-k8s (2)
**Onda:** 1 (plataforma) — bloqueia a implementacao das US-F4-07/08 no novo transporte e a refatoracao da US-F4-10/11

## Contexto

Decisao do time de 03/11/2026 ([RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md)):
a mensageria SNS/SQS (RFC-0006, ADR-0009) e substituida por **HTTP direto**. Cada
comando do orquestrador vira um endpoint no participante; cada evento vira a resposta
sincrona desse endpoint ou um callback `POST /ordens-servico/{numero}/eventos`. Os
nomes e payloads do `asyncapi.yaml` continuam como vocabulario. A fonte da verdade e
[`docs/contratos/http-interno.md`](../contratos/http-interno.md) — leia inteira antes
de implementar.

Principios: timeout 5 s e 3 tentativas com backoff (200 ms, 800 ms, 3 s) so para
`5xx`/timeout/rede; `4xx` nao repete; idempotencia por `numeroOS` (comandos) e por
`id` do envelope (callbacks); JWT de servico `role: SERVICO` assinado com o mesmo
`JWT_SECRET` da Lambda; `x-correlation-id` e `traceparent` em toda chamada; chamadas
entre servicos pelo DNS interno, sem passar pelo gateway; retry esgotado -> saga
parada -> alerta -> `reprocessar`.

## Criterios de Aceite

### Kit (`@guilhermeqmaia/oficina-kit`, nova minor)

- [ ] `Role.SERVICO` no enum de roles; `RolesGuard` aceita `SERVICO` em rotas marcadas com `@Roles(Role.SERVICO)`; `JwtStrategy` aceita `sub` = nome do servico (sem `cpf`/`usuarioId`)
- [ ] `@guilhermeqmaia/oficina-kit/http`: `ServicoHttpClient` (ou `InternalHttpModule.forRoot({ baseUrls, timeoutMs: 5000, tentativas: 3, backoffMs: [200, 800, 3000] })`) que: injeta `Authorization: Bearer <JWT SERVICO>`, propaga `x-correlation-id` e `traceparent` do contexto do kit `logging`, repete so `5xx`/timeout/erro de rede, devolve erro tipado para `409 { motivo }` (recusa de negocio) e `404`
- [ ] `mintServiceToken({ servico, secret })` em `/testing` e em runtime (emissao local do JWT `SERVICO`, `iss=oficina-auth-lambda`, expiracao curta, cache ate expirar)
- [ ] `criarEnvelope` mantido para o corpo dos callbacks (sem `correlationId` no corpo; `id` UUID v7, `type`, `version`, `occurredAt`, `producer`, `data`)
- [ ] Modulo `messaging` (SNS/SQS/outbox) marcado `@deprecated` no README e no CHANGELOG, mantido no pacote por compatibilidade
- [ ] Template de servico (`templates/service/`) gerado sem `MessagingModule` e com exemplo de controller `@Roles(Role.SERVICO)` e de uso do cliente HTTP; testes >= 80%

### OS Service

- [ ] `OrquestradorSagaService` chama Execucao/Billing pelo cliente HTTP do kit **apos o commit** da transacao da saga e converte a resposta (`201`/`200`/`409`) no evento esperado (`execucao.enfileirada`/`recusada`, `billing.orcamento-gerado`, `execucao.iniciada`/`recusada`, `billing.cobranca-criada`, `billing.orcamento-cancelado`, `execucao.reservas-liberadas`), aplicando-o na mesma maquina de estados `SagaOS` (sem mudanca de dominio)
- [ ] `POST /ordens-servico/{numero}/eventos` (`@Roles(Role.SERVICO)`): valida o envelope (schema do kit), deduplica por `id` em `processed_messages` (`200 { aplicado: false, duplicado: true }`), entrega ao orquestrador, responde `200 { aplicado, passo, status }`, `404` OS inexistente, `409` em conflito de lock otimista
- [ ] Removidos: `outbox` (tabela + migration de drop), `OutboxPoller`, `SqsConsumer`, os 13 handlers de `infrastructure/messaging/`, publicacao dos eventos `os.*`, `SNS_TOPIC_ARN`/`SQS_QUEUE_URL`/`AWS_ENDPOINT` do `.env.example`, ConfigMap e overlay `k8s-aws`; `architecture.spec.ts` atualizado
- [ ] Retry esgotado numa chamada: a saga fica no passo (historico `chamada-falhou` com tentativas), `oficina_os_sagas_paradas` sobe, `POST /admin/sagas/:numero/reprocessar` repete a chamada (US-F4-11); metrica `oficina_http_interno_total{origem,destino,rota,resultado=sucesso|recusa|esgotado|erro}` (nome unico, ver [US-F4-16](f4-16-observabilidade-distribuida.md#nomes-das-metricas-decisao-de-10112026))
- [ ] Notificacao in-process alimentada pelos eventos `billing.*` recebidos por HTTP (US-F4-12 nao precisa de fila)
- [ ] `docker-compose.yml` sem o profile `messaging`/LocalStack; `scripts/messaging-local.sh` removido; README do repo atualizado (secao "Mensageria" vira "Comunicacao entre servicos")
- [ ] Testes: unitarios do orquestrador com o cliente HTTP mockado (sucesso, `409`, `5xx` com retry, esgotado); e2e do callback (envelope valido, duplicado, OS inexistente, conflito `409`, role errada `403`); cobertura >= 80%

### Billing Service e Execucao Service

- [ ] Endpoints `SERVICO` do contrato expostos com os codigos de resposta de [`http-interno.md`](../contratos/http-interno.md) (Billing: `POST /orcamentos`, `POST /orcamentos/{n}/cobrar`, `DELETE /orcamentos/{n}`; Execucao: `POST /execucao/ordens`, `POST /execucao/ordens/{n}/iniciar`, `DELETE /execucao/ordens/{n}`), idempotentes por `numeroOS`
- [ ] Callbacks ao OS (`POST /ordens-servico/{n}/eventos`) pelo cliente HTTP do kit nas acoes de pessoa/Mercado Pago (Execucao: `diagnostico-concluido`, `finalizada`; Billing: `orcamento-aprovado`, `orcamento-rejeitado`, `pagamento-aprovado`, `pagamento-recusado`); `409` do OS -> reler e repetir; falha apos 3 tentativas -> log de erro + metrica (o estado fica no participante)
- [ ] Sem `MessagingModule`, outbox, `processed_messages` ou itens `MSG#`; variaveis `OS_SERVICE_URL`, `BILLING_SERVICE_URL`, `EXECUCAO_SERVICE_URL`, `JWT_SECRET` nos ConfigMaps/Secrets
- [ ] (Os endpoints de dominio em si sao das US-F4-07/08/09; esta story garante o **contrato de transporte** e o teste de contrato do callback)

### infra-k8s

- [ ] Stage `messaging/` removido (destroy documentado), parametros SSM `/oficina/messaging/*` e `scripts/messaging-vars.sh` apagados; vars `SNS_TOPIC_ARN`/`SQS_QUEUE_URL` removidas dos repos (`gh variable delete`)
- [ ] Gateway com os tres prefixos, **incluindo a Execucao** (`/execucao*`, `/catalogo*`, `/estoque*`) e `/admin*` -> OS Service; nenhuma rota interna (`/ordens-servico/{n}/eventos` so com `SERVICO`, que o authorizer da Lambda nunca emite — documentado)
- [ ] `NetworkPolicy`/Service DNS: `os-service:3000`, `billing-service:3001`, `execucao-service:3002` no namespace `oficina`; `JWT_SECRET` compartilhado via Secrets Manager

### Hub (docs)

- [ ] `docker-compose.fase4.yml` sem LocalStack (US-F4-14 depende disso); `docs/contratos/openapi/` com o OpenAPI exportado de cada servico (US-F4-15)
- [ ] QA Plan [QA_PLAN_US-F4-18](../qa-plans/QA_PLAN_US-F4-18.md) executado: chamada com retry, callback idempotente, `409`, JWT `SERVICO` recusado com role de usuario e vice-versa

## APIs que expoe

| Metodo | Rota | Servico | Role | Corpo | Resposta |
|---|---|---|---|---|---|
| POST | `/ordens-servico/{numero}/eventos` | OS | SERVICO | envelope | `200 { aplicado, duplicado?, passo, status }` · `404` · `409` |
| POST | `/execucao/ordens` · `/execucao/ordens/{n}/iniciar` · DELETE `/execucao/ordens/{n}` | Execucao | SERVICO | ver [`http-interno.md`](../contratos/http-interno.md) | `201`/`200`/`409 { motivo }` |
| POST | `/orcamentos` · `/orcamentos/{n}/cobrar` · DELETE `/orcamentos/{n}` | Billing | SERVICO | ver [`http-interno.md`](../contratos/http-interno.md) | `201`/`200`/`409 { motivo }` |

## APIs que consome

| Quem | Chama | Com |
|---|---|---|
| OS Service | os 6 endpoints `SERVICO` acima | JWT `sub: os-service`, retry 3x, `x-correlation-id` |
| Execucao | `POST /ordens-servico/{n}/eventos` (OS) | JWT `sub: execucao-service`, retry 3x |
| Billing | `POST /ordens-servico/{n}/eventos` (OS) | JWT `sub: billing-service`, retry 3x |

## O que salva no banco

| Servico | Banco | Muda |
|---|---|---|
| OS Service | Postgres `oficina_os` | **remove** `outbox`; mantem `processed_messages` (dedup de callbacks, purga 7 dias) e `saga_os` (historico ganha `chamada-falhou`/`tentativas`) |
| Billing | Postgres `oficina_billing` | nada de transporte (sem outbox/processed_messages) |
| Execucao | DynamoDB `oficina-execucao` | nada de transporte (sem `MSG#`) |
| infra | — | SNS/SQS/DLQ/SSM destruidos |

## Dependencias

- [US-F4-01](f4-01-kit-compartilhado.md) (kit publicado), [US-F4-05](f4-05-gateway-multi-servico.md) (gateway), [US-F4-DOC-03](f4-doc-03-contratos-eventos.md) (vocabulario)
- Desbloqueia: [US-F4-07](f4-07-execucao-service.md), [US-F4-08](f4-08-billing-orcamento.md), [US-F4-14](f4-14-bdd-fluxo-completo.md), [US-F4-15](f4-15-testes-de-contrato.md), [US-F4-16](f4-16-observabilidade-distribuida.md)

## Referencias

- [RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md) · [`docs/contratos/http-interno.md`](../contratos/http-interno.md) · [runbook `saga-reprocessar.md`](../runbooks/saga-reprocessar.md)
