# US-F4-16: Observabilidade Distribuida — Traces atraves das Chamadas HTTP, Dashboards por Servico e Alerta de Saga Parada

**User Story:** Como Operacao, quero seguir uma OS atraves dos tres servicos num unico trace que atravessa as chamadas e callbacks HTTP, e ver latencia/erro entre os servicos e as sagas paradas, para diagnosticar falhas do fluxo distribuido em minutos.

**Prioridade:** Alta
**Story Points:** 5
**Status:** To Do (reescrita em 03/11/2026: transporte HTTP, sem filas/DLQ — RFC-0008)
**DDD Domain:** Transversal
**DDD Layer:** Infrastructure (observabilidade)
**Repositorio:** kit + os/billing/execucao + infra-k8s `observability/`

## Contexto

Enunciado: usar a observabilidade da Fase 3 e demonstrar "monitoramento e
rastreamento dos fluxos distribuidos". Com a RFC-0008 o contexto de trace
atravessa **chamadas HTTP** (OS -> Execucao/Billing) e **callbacks** (Execucao/Billing
-> OS); a saude do fluxo e medida por latencia/erro dessas chamadas e por sagas
paradas — nao ha fila nem DLQ para observar.

## Criterios de Aceite

- [ ] `traceparent` e `x-correlation-id` (numero da OS) propagados pelo cliente HTTP do kit em toda chamada e callback; o servidor (kit `logging`) continua o trace recebido — um unico trace do `POST /ordens-servico` ate o callback `execucao.diagnostico-concluido` e alem (span `http.client` filho do caso de uso; span do callback filho da acao do mecanico/cliente)
- [ ] Logs JSON de todos os servicos com `trace_id`, `correlation_id`, `servico`, `rota`, `tentativa` — filtro por OS mostra a saga inteira nos tres servicos
- [ ] Metricas do kit: `oficina_http_interno_duracao_seconds{origem,destino,rota,status}`, `oficina_http_interno_total{origem,destino,rota,resultado=sucesso|recusa|esgotado|erro}`, `oficina_callbacks_total{type,resultado=aplicado|duplicado|ignorado|conflito|nao_encontrado|erro}` (nomes unificados em 10/11/2026 — ver "Nomes das metricas" abaixo)
- [ ] Dashboards: "Oficina — Fluxo distribuido" (sagas por passo, tempo por passo, compensacoes, **latencia p95 e taxa de erro por par origem->destino**, callbacks por `type`, sagas paradas) + um painel tecnico por servico (Fase 3)
- [ ] Alertas: **saga parada** (`oficina_os_sagas_paradas > 0` por mais de `SAGA_ALERTA_PARADA_MIN`), retry esgotado (`resultado=esgotado > 0` em 5 min), 5xx por servico, latencia p95 entre servicos > 2 s, callback com `409` repetido, webhook do Mercado Pago com falha de assinatura — **sem alertas de DLQ**
- [ ] Runbooks por alerta (padrao da Fase 3); saga parada aponta para [`docs/runbooks/saga-reprocessar.md`](../runbooks/saga-reprocessar.md)
- [ ] Evidencia no QA Plan: screenshot de um trace atravessando os tres servicos (chamada + callback) e do dashboard com a latencia entre servicos

## Nomes das metricas (decisao de 10/11/2026)

As stories e o codigo usavam tres nomes para a mesma coisa. Fica **um so**, igual nesta story,
na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md), no `http-interno.md` e no codigo:

| Sinal | Nome unico | Substitui |
|---|---|---|
| Resultado de cada chamada entre servicos | `oficina_http_interno_total{origem,destino,rota,resultado}` — `sucesso` (2xx ou 409 "ja existe"), `recusa` (409 de negocio), `esgotado` (5xx/timeout/rede apos 3 tentativas), `erro` (outro 4xx, sem retry) | `oficina_os_http_interno_total{servico,rota,resultado}` (US-F4-18, nunca implementada) e `oficina_integracoes_total{integracao=execucao-service\|billing-service}` (Fase 3 — **deprecated** para os participantes; continua emitida enquanto o painel "Erros de integracao" do dashboard de negocio a usar; `integracao=webhook-notificacao` segue valendo) |
| Duracao de cada chamada (inclui retentativas) | `oficina_http_interno_duracao_seconds{origem,destino,rota,status}` (`status` = ultimo HTTP ou `sem_resposta`) | — |
| Callbacks recebidos pelo OS | `oficina_callbacks_total{type,resultado}` — `aplicado`, `duplicado` (id ja processado ou passo ja concluido), `ignorado` (fora de ordem/desconhecido: 200 com `aplicado=false`), `conflito` (409), `nao_encontrado` (404), `erro` (5xx) | — |

`rota` e o template (`POST /orcamentos/{numero}/cobrar`), nunca o numero da OS. `type` fora do
contrato vira `outro`. Enquanto o kit (0.3.0) nao publicar essas metricas, elas ficam no
os-service (`src/observabilidade/metrics.registry.ts`, TODO de migracao) com os mesmos nomes —
dashboards e monitores nao mudam quando migrarem.

## O que salva no banco

Nao se aplica (metricas/traces vao para o Datadog/Prometheus da Fase 3).

## Dependencias

- [US-F4-01](f4-01-kit-compartilhado.md), [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)
