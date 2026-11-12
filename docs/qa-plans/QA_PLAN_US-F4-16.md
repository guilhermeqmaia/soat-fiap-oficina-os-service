# QA Plan — US-F4-16: Observabilidade Distribuída (traces HTTP, saga parada, dashboards e alertas)

## Resumo
Valida que uma OS pode ser seguida pelos três serviços: propagação de `traceparent` e
`x-correlation-id` (= número da OS) em toda chamada e callback, logs JSON com `trace_id`,
`correlation_id`, `servico`, `rota`, `tentativa`, as métricas `oficina_http_interno_total`,
`oficina_http_interno_duracao_seconds` e `oficina_callbacks_total`, o gauge
`oficina_os_sagas_paradas`, o dashboard "Oficina — Fluxo distribuído", os alertas e os runbooks.

O lado do **os-service** está implementado e provado por teste automatizado; o lado da
**infra-k8s** (coleta, dashboard, monitores) está na branch
`feat/f4-16-observabilidade-fluxo-distribuido` daquele repo. Tudo que precisa do **Datadog
com os três serviços no ar no EKS** está marcado como **[AMBIENTE REAL]** e detalhado em
[`docs/fluxo-3/evidencias-pendentes.md`](../fluxo-3/evidencias-pendentes.md).

## Pré-requisitos
- Local: Node 22, Docker, `npm ci`, `npx prisma generate`.
- Ponta a ponta local: `npm run e2e:up` (`docker-compose.fase4.yml`; Billing/Execução = stubs).
- **[AMBIENTE REAL]**: EKS ligado, os três serviços com `DD_TRACE_ENABLED=true`, `DD_SERVICE`
  distinto e `DD_ENV` igual; agente Datadog com `observability/datadog-values.yaml` da branch
  acima; `terraform apply` do stage `observability/` com `DD_API_KEY`/`DD_APP_KEY`; Execução com
  os endpoints de domínio e Billing com `feat/fluxo-2-billing` mesclado.

## Cenários de Teste

### TS-01: Chamada de saída leva `x-correlation-id` e, com APM, `traceparent` do span ativo
- **Tipo:** Automatizado
- **Critério:** propagação pelo cliente HTTP do kit
- **Passos:** `npx jest --config jest.unit.config.ts http-participantes-saga` (bloco "continuidade do trace (APM ativo)")
- **Resultado esperado:** requisição ao participante com `x-correlation-id` = número da OS; com tracer simulado ativo, `traceparent` com o mesmo trace id do span corrente
- **Resultado alternativo:** header ausente ou trace id diferente → o trace quebra entre serviços

### TS-02: Callback com `traceparent` continua o trace nos logs
- **Tipo:** Automatizado (e2e jest)
- **Critério:** servidor continua o trace recebido
- **Passos:** `npx jest --config jest.integration.config.ts ordem-de-servico.e2e -t "traceparent"`
- **Resultado esperado:** linhas `callback recebido` e `saga avancou` com `trace_id` = trace do header e `correlation_id` = número da OS

### TS-03: Campos de rastreio nos logs
- **Tipo:** Automatizado (unit do gateway, orquestrador e callback; `rastreio.spec.ts`)
- **Critério:** logs com `trace_id`, `correlation_id`, `servico`, `rota`, `tentativa`
- **Passos:** `npm run test:unit -- rastreio http-participantes-saga receber-callback`
- **Resultado esperado:** todos os campos presentes nas asserções

### TS-04: Métricas do fluxo distribuído com os labels do contrato
- **Tipo:** Automatizado
- **Critério:** `oficina_http_interno_total{origem,destino,rota,resultado}`, `oficina_http_interno_duracao_seconds{origem,destino,rota,status}`, `oficina_callbacks_total{type,resultado}`
- **Passos:** `npm run test:unit -- metrics-zero-init http-participantes-saga receber-callback`; localmente, `curl -s localhost:3000/metrics | grep -E "oficina_(http_interno|callbacks)"`
- **Resultado esperado:** séries inicializadas com 0 para cada par/rota/resultado; `rota` é template (`POST /orcamentos/{numero}/cobrar`), nunca o número; `type` fora do contrato vira `outro`

### TS-05: Retry esgotado → `chamada-falhou` → saga parada → reprocessar
- **Tipo:** Automatizado (unit, integração SQL real, BDD serviço e BDD e2e)
- **Critério:** alerta "saga parada" tem insumo
- **Passos:** `npx cucumber-js --tags @falha-plataforma` e `npm run test:bdd:e2e -- --tags @falha-plataforma` (com `npm run e2e:up`)
- **Resultado esperado:** 3 chamadas ao participante, histórico `chamada-falhou` com `tentativas: 3`, `oficina_http_interno_total{resultado="esgotado"}` +1, `oficina_os_sagas_paradas` = 1 no próximo ciclo do relógio; após `POST /admin/sagas/{n}/reprocessar` a saga segue e o gauge volta a 0

### TS-06: Logs dos três containers com o mesmo `correlation_id`
- **Tipo:** Manual (local)
- **Passos:** roteiro [`teste-manual-ponta-a-ponta.md`](../fluxo-3/teste-manual-ponta-a-ponta.md) §3.7 — `docker compose -f docker-compose.fase4.yml logs | grep <numero>`
- **Resultado esperado:** linhas do os-service, billing e execução com `correlation_id` = número da OS

### TS-07: **[AMBIENTE REAL]** Um único trace atravessando os três serviços
- **Tipo:** Manual (Datadog)
- **Passos:** item 1 de `evidencias-pendentes.md` (abrir OS, concluir diagnóstico na Execução, APM → Traces com `@correlation_id:<numero>`)
- **Resultado esperado:** flame graph `os-service` → `http.client POST /execucao/ordens` → `execucao-service`; e `execucao-service` → callback → `os-service` → `http.client POST /orcamentos` → `billing-service`, mesmo trace id; pivô log ↔ trace funcionando
- **Evidência:** `docs/qa-plans/evidencias/US-F4-16-trace-<data>.png`

### TS-08: **[AMBIENTE REAL]** Dashboard "Oficina — Fluxo distribuído"
- **Tipo:** Manual (Datadog)
- **Passos:** item 2 de `evidencias-pendentes.md` (caminho feliz + compensação + retry esgotado sem reprocessar; abrir `dashboard_fluxo_distribuido_url`)
- **Resultado esperado:** sagas por passo, tempo por passo, compensações, latência p95 e taxa de erro por par origem → destino, callbacks por `type`/`resultado`, "Sagas paradas agora" > 0 e depois 0
- **Evidência:** `docs/qa-plans/evidencias/US-F4-16-dashboard-<data>.png`

### TS-09: **[AMBIENTE REAL]** Alertas disparando com link do runbook
- **Tipo:** Manual (Datadog)
- **Passos:** item 3 de `evidencias-pendentes.md` (retry esgotado; saga parada com `SAGA_ALERTA_PARADA_MIN=5`; demais opcionais)
- **Resultado esperado:** monitor em ALERT com `destino:<servico>`; e-mail com o link do runbook; sem alertas de DLQ
- **Evidência:** `docs/qa-plans/evidencias/US-F4-16-alertas-<data>.png`

### TS-10: Runbooks por alerta
- **Tipo:** Manual (revisão)
- **Passos:** abrir cada monitor em `observability/monitors.tf` (infra-k8s) e conferir o link
- **Resultado esperado:** um runbook por alerta em [`docs/runbooks/`](../runbooks/): `retry-esgotado.md`, `saga-parada.md` (→ `saga-reprocessar.md`), `erros-5xx-por-servico.md`, `latencia-entre-servicos.md`, `callback-conflito-repetido.md`

### TS-11: Terraform do stage `observability/` válido
- **Tipo:** Automatizado (CI do infra-k8s)
- **Passos:** job `validate (observability)` do `ci.yml` do infra-k8s no PR (`terraform fmt -check` + `validate`)
- **Resultado esperado:** verde; `datadog_metric_tag_configuration.latencia_http_interno` com as tags `origem, destino, rota, status` (as mesmas do histograma no código)

## Casos de Borda
- Sem APM local o kit **não** envia `traceparent` (só `x-correlation-id`): a correlação local é pelo número da OS — esperado, não é falha
- Primeira amostra do histograma só existe após a primeira chamada: painel de p95 vazio em ambiente recém-criado
- Agente filtrando `kubernetes_container_names: ["app"]`: se o container do Billing/Execução tiver outro nome, "5xx por serviço" e o par `billing → os` ficam vazios (item 4 de `evidencias-pendentes.md`)
- `oficina_os_sagas_paradas` conta no **próximo ciclo** do relógio (`SAGA_TIMEOUTS_INTERVALO_MS`), não instantaneamente

## Rastreabilidade
| Critério | Cenários |
|---|---|
| `traceparent` + `x-correlation-id` propagados; trace único | TS-01, TS-02, TS-07 |
| Logs com `trace_id`, `correlation_id`, `servico`, `rota`, `tentativa` | TS-03, TS-06 |
| Métricas `http_interno_*` e `callbacks_total` | TS-04, TS-05 |
| Dashboard "Fluxo distribuído" | TS-08, TS-11 |
| Alertas (saga parada, retry esgotado, 5xx, p95, 409 repetido) | TS-05, TS-09, TS-11 |
| Runbooks por alerta | TS-10 |
| Evidência (trace + dashboard) no QA Plan | TS-07, TS-08 |

## Checklist de Validação
- [x] TS-01..TS-05 automatizados e verdes (unit, integração, BDD serviço e e2e — 11/11/2026)
- [x] TS-06 executado no roteiro manual local (saídas reais em `teste-manual-ponta-a-ponta.md`)
- [x] TS-10 runbooks escritos
- [ ] TS-11 CI do infra-k8s no PR da branch `feat/f4-16-observabilidade-fluxo-distribuido`
- [ ] TS-07, TS-08, TS-09 **[AMBIENTE REAL]** — prints em `docs/qa-plans/evidencias/`

## Comandos Úteis
```bash
npm run test:unit -- rastreio metrics-zero-init http-participantes-saga receber-callback
npx jest --config jest.integration.config.ts ordem-de-servico.e2e
npx cucumber-js --tags @falha-plataforma
npm run e2e:up && npm run test:bdd:e2e -- --tags @falha-plataforma; npm run e2e:down
curl -s localhost:3000/metrics | grep -E "oficina_(http_interno|callbacks|os_sagas_paradas)"
```
