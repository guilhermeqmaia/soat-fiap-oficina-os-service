# FLUXO 3 — evidências que dependem de ambiente real (US-F4-16)

Atualizado em 10/11/2026, branch `feat/f4-16-observabilidade-os-service` (os-service) e
`feat/f4-16-observabilidade-fluxo-distribuido` (infra-k8s). O que está aqui **não** dá para
provar com teste automatizado: precisa dos três serviços no ar com o Datadog. Cada item diz o
pré-requisito, como produzir a evidência e onde guardar o print.

Destino dos prints: `docs/qa-plans/evidencias/US-F4-16-<item>-<data>.png`, referenciados no
`QA_PLAN_US-F4-16.md` (ainda não existe — criar com `/qa-plan F4-16` ao fechar a story).

## O que já está provado sem ambiente real

| Item | Como foi provado |
|---|---|
| Métricas `oficina_http_interno_total`, `oficina_http_interno_duracao_seconds`, `oficina_callbacks_total` com todos os resultados e inicializadas com 0 | unit: `metrics-zero-init.spec.ts`, `http-participantes-saga.spec.ts`, `receber-callback.use-case.spec.ts`; e2e: `ordem-de-servico.e2e.spec.ts` ("oficina_callbacks_total conta …") |
| Retry esgotado → histórico `chamada-falhou` com `tentativas` e saga contada em `oficina_os_sagas_paradas` | unit do orquestrador e da entidade; integração `prisma-saga.repository.integration.spec.ts` (SQL real no Postgres); e2e "Execucao fora do ar …" |
| `traceparent` recebido no callback continua o trace nos logs (sem APM) | e2e "traceparent recebido continua o trace": linhas `callback recebido` e `saga avancou` saem com `trace_id` = trace id do header e `correlation_id` = OS |
| Com APM, a chamada de saída leva `traceparent` com o **mesmo** trace id do span ativo | unit `http-participantes-saga.spec.ts` › "continuidade do trace (APM ativo)" — tracer simulado no `tracer-bridge` do kit |
| Logs com `trace_id`, `correlation_id`, `servico`, `rota`, `tentativa` | unit do gateway, do orquestrador e do callback (asserções nos campos) |

O que **não** está provado: que o `dd-trace` real cria o span `http.client` filho do caso de uso, que
o servidor do participante continua o trace e que o Datadog junta tudo num único trace. Isso é o item 1.

## 1. Trace atravessando os três serviços (chamada + callback)

**Pré-requisitos**
- EKS religado, os três serviços no ar com `DD_TRACE_ENABLED=true`, `DD_SERVICE` distinto
  (`os-service`, `billing-service`, `execucao-service`), `DD_ENV` igual nos três e o agente do
  Datadog instalado (`observability/datadog-values.yaml`).
- Execução Service com os endpoints de domínio (bloqueio B1 do diagnóstico) e Billing com
  `feat/fluxo-2-billing` mergeado (B2).

**Passo a passo**
1. Abrir uma OS pelo gateway (`POST /ordens-servico`) e anotar o `numero` e o header
   `x-correlation-id` da resposta.
2. APM → Traces, filtro `@correlation_id:<numero>` (o kit grava a tag no span). Abrir o trace do
   `POST /ordens-servico`: deve haver `os-service` → span `http.client POST /execucao/ordens` →
   span do `execucao-service` (mesmo trace id).
3. Concluir o diagnóstico na Execução (ação do mecânico) e abrir o trace dessa requisição: deve ter
   `execucao-service` → `http.client POST /ordens-servico/{n}/eventos` → `os-service` (callback) →
   `http.client POST /orcamentos` → `billing-service`.
4. Logs: `correlation_id:<numero>` (ou `@correlationId:<numero>`) mostra as linhas dos três serviços;
   clicar numa linha do OS e conferir o pivô log → trace (`dd.trace_id`).

**Prints**: (a) flame graph do passo 3 com os três serviços; (b) lista de logs filtrada pela OS.

**Se o trace quebrar** entre dois serviços: conferir se o header `traceparent` chega (log de
request do destino) e se o destino inicializa o tracer antes do Nest (`iniciarTracing()` do kit no
topo do `main.ts`). O os-service já propaga; sem APM ativo o kit **não** envia `traceparent` (só
`x-correlation-id`) — por isso o item precisa do Datadog ligado.

## 2. Dashboard "Oficina — Fluxo distribuído"

**Pré-requisitos**: `terraform apply` do stage `observability/` do infra-k8s com `DD_API_KEY`/
`DD_APP_KEY` e `gateway_url` (B5); agente com o `datadog-values.yaml` desta branch (mapeia as séries
novas — sem isso os painéis ficam vazios).

**Passo a passo**
1. Rodar um caminho feliz completo e um de compensação (orçamento rejeitado) — o BDD ponta a ponta
   do hub serve, ou os curls do `QA_PLAN_US-F4-18.md`.
2. Forçar um retry esgotado: escalar a Execução para 0 réplicas, abrir uma OS, voltar a réplica e
   **não** reprocessar ainda.
3. Abrir o output `dashboard_fluxo_distribuido_url`.

**Prints**: dashboard inteiro mostrando "Sagas paradas agora" > 0, "Latência p95 por par
origem → destino", "Taxa de erro por par" com o pico do passo 2 e "Callbacks por type e resultado".
Depois de `POST /admin/sagas/<n>/reprocessar`, print de "Sagas paradas" voltando a 0.

## 3. Alertas disparando

| Alerta | Como provocar | Print |
|---|---|---|
| Retry esgotado | passo 2 do item 2 | monitor em ALERT com `destino:execucao-service` |
| Saga parada | deixar a saga do passo 2 parada por `saga_alerta_parada_min` (use `SAGA_ALERTA_PARADA_MIN=5` e `saga_alerta_parada_min=5` no ambiente de demo) | monitor em ALERT + e-mail com o link do runbook |
| Callback com 409 repetido | difícil de provocar sem carga; opcional (k6 com callbacks concorrentes na mesma OS) | — |
| Latência p95 > 2 s | latência artificial no destino (ex.: `tc`/proxy) ou Execução com 1 réplica sob `perf:load` | opcional |
| 5xx por serviço | derrubar o banco de um serviço (scale do RDS proxy / credencial inválida) | opcional |

## 4. Verificações que só o CI faz

- `terraform fmt -check` e `terraform validate` do stage `observability/`: o Terraform não estava
  instalado na máquina em que os arquivos foram escritos; o job `validate (observability)` do
  `ci.yml` do infra-k8s roda os dois no PR.
- Os outros dois serviços precisam ser raspados pelo agente (o `datadog-values.yaml` filtra
  `kubernetes_container_names: ["app"]`): conferir o nome do container nos deployments do Billing
  e da Execução, senão "5xx por serviço" e o par `billing → os` ficam sem dados.
