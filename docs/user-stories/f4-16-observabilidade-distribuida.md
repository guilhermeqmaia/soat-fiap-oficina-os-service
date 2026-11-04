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
- [ ] Metricas do kit: `oficina_http_interno_duracao_seconds{origem,destino,rota,status}`, `oficina_http_interno_total{origem,destino,rota,resultado=sucesso|recusa|esgotado}`, `oficina_callbacks_total{type,resultado=aplicado|duplicado|conflito|erro}`
- [ ] Dashboards: "Oficina — Fluxo distribuido" (sagas por passo, tempo por passo, compensacoes, **latencia p95 e taxa de erro por par origem->destino**, callbacks por `type`, sagas paradas) + um painel tecnico por servico (Fase 3)
- [ ] Alertas: **saga parada** (`oficina_os_sagas_paradas > 0` por mais de `SAGA_ALERTA_PARADA_MIN`), retry esgotado (`resultado=esgotado > 0` em 5 min), 5xx por servico, latencia p95 entre servicos > 2 s, callback com `409` repetido, webhook do Mercado Pago com falha de assinatura — **sem alertas de DLQ**
- [ ] Runbooks por alerta (padrao da Fase 3); saga parada aponta para [`docs/runbooks/saga-reprocessar.md`](../runbooks/saga-reprocessar.md)
- [ ] Evidencia no QA Plan: screenshot de um trace atravessando os tres servicos (chamada + callback) e do dashboard com a latencia entre servicos

## O que salva no banco

Nao se aplica (metricas/traces vao para o Datadog/Prometheus da Fase 3).

## Dependencias

- [US-F4-01](f4-01-kit-compartilhado.md), [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)
