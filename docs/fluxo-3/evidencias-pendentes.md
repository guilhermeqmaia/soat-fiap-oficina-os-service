# FLUXO 3 — evidências que dependem de ambiente real (US-F4-16)

Atualizado em 11/11/2026 (seção "provado localmente", US-F4-14); itens de ambiente real de 10/11/2026, branch `feat/f4-16-observabilidade-os-service` (os-service) e
`feat/f4-16-observabilidade-fluxo-distribuido` (infra-k8s). O que está aqui **não** dá para
provar com teste automatizado: precisa dos três serviços no ar com o Datadog. Cada item diz o
pré-requisito, como produzir a evidência e onde guardar o print.

Destino dos prints: `docs/qa-plans/evidencias/US-F4-16-<item>-<data>.png`, referenciados no
[`QA_PLAN_US-F4-16.md`](../qa-plans/QA_PLAN_US-F4-16.md) (TS-07, TS-08, TS-09). Visão do card inteiro:
[`QA_PLAN_FLUXO-3.md`](../qa-plans/QA_PLAN_FLUXO-3.md).

## O que já está provado sem ambiente real

| Item | Como foi provado |
|---|---|
| Métricas `oficina_http_interno_total`, `oficina_http_interno_duracao_seconds`, `oficina_callbacks_total` com todos os resultados e inicializadas com 0 | unit: `metrics-zero-init.spec.ts`, `http-participantes-saga.spec.ts`, `receber-callback.use-case.spec.ts`; e2e: `ordem-de-servico.e2e.spec.ts` ("oficina_callbacks_total conta …") |
| Retry esgotado → histórico `chamada-falhou` com `tentativas` e saga contada em `oficina_os_sagas_paradas` | unit do orquestrador e da entidade; integração `prisma-saga.repository.integration.spec.ts` (SQL real no Postgres); e2e "Execucao fora do ar …" |
| `traceparent` recebido no callback continua o trace nos logs (sem APM) | e2e "traceparent recebido continua o trace": linhas `callback recebido` e `saga avancou` saem com `trace_id` = trace id do header e `correlation_id` = OS |
| Com APM, a chamada de saída leva `traceparent` com o **mesmo** trace id do span ativo | unit `http-participantes-saga.spec.ts` › "continuidade do trace (APM ativo)" — tracer simulado no `tracer-bridge` do kit |
| Logs com `trace_id`, `correlation_id`, `servico`, `rota`, `tentativa` | unit do gateway, do orquestrador e do callback (asserções nos campos) |

## O que passou a ficar provado localmente (US-F4-14, 11/11/2026)

Ambiente ponta a ponta `docker-compose.fase4.yml` (os-service real + Postgres, Billing e Execução
como stubs de `e2e/stubs` que seguem o `http-interno.md` e validam tudo contra
`docs/contratos/schemas`, Mailpit). Provado pelo BDD `features/e2e/ciclo-completo-os.feature`
(`npm run test:bdd:e2e`, 12 cenários verdes) e pelo roteiro
[`teste-manual-ponta-a-ponta.md`](teste-manual-ponta-a-ponta.md) (saídas reais coladas):

| Item | Como foi provado (sem Datadog) |
|---|---|
| Ciclo completo por HTTP entre containers (DNS interno `os-service:3000`, `billing-service:3001`, `execucao-service:3002`), do `POST /ordens-servico` ao `ENTREGUE` | BDD "Caminho feliz…"; roteiro §3 |
| Callbacks enviados pelo participante com o `ClienteHttpInterno` do kit (JWT `SERVICO` do produtor, `x-correlation-id`) aceitos pelo OS; JWT `SERVICO` do OS aceito pelos participantes com o mesmo `JWT_SECRET` | BDD (step "recebeu a chamada … com o JWT de serviço do OS Service"); roteiro §3.1 (`sub=os-service`) |
| Requisições do OS (corpo dos 6 comandos), respostas dos participantes e envelopes dos callbacks conferem com os JSON Schemas, em execução real | `GET /__stub/violacoes` vazio no fim de cada cenário (o `After` do BDD reprova se houver); roteiro §9 |
| Compensações chegando nos participantes com `{ motivo }` (rejeição e cancelamento em `EM_DIAGNOSTICO`/`AGUARDANDO_APROVACAO`); cancelar em `EM_EXECUCAO`/`AGUARDANDO_PAGAMENTO` recusado | BDD `@compensacao`/`@cancelamento`; roteiro §4, §5, §6 |
| Pagamento recusado sem rollback; `reprocessar` gera nova cobrança com novo link e novo e-mail | BDD `@pagamento`; roteiro §5 |
| Retry real (200/800 ms) contra um container: 5xx transitório absorvido; 3 × 5xx → `chamada-falhou` + `oficina_http_interno_total{resultado="esgotado"}` + `oficina_os_sagas_paradas` = 1 → `reprocessar` → segue e o gauge volta a 0 | BDD `@falha-plataforma` (3 cenários); roteiro §7 |
| Idempotência: callback reenviado com o mesmo `id` → `duplicado`, sem segundo orçamento/notificação/e-mail; `POST /execucao/ordens` repetido devolve a mesma posição | BDD `@idempotencia` (3 cenários); roteiro §8 |
| E-mails reais via SMTP (Mailpit) em cada marco, com o link de pagamento do Billing no corpo; `GET /notificacoes` com canal `EMAIL` | BDD (steps de Mailpit e "histórico de notificações"); roteiro §3.7 |
| `oficina_callbacks_total` e `oficina_http_interno_total` aumentando exatamente o esperado por cenário | BDD (step "as métricas do OS Service aumentaram", diferença antes/depois do `/metrics`); roteiro §3.7 |
| Logs JSON dos três containers com o mesmo `correlation_id` (= número da OS) | roteiro §3.7 (`docker compose logs` filtrado pela OS) |

Continua **pendente** (precisa dos serviços reais e/ou do Datadog): itens 1–4 abaixo, e rodar o
mesmo BDD com `BILLING_IMAGE`/`EXECUCAO_IMAGE` reais (`BDD_E2E_REAIS=1`, sem os cenários `@stub`)
quando o Billing mesclar `feat/fluxo-2-billing` e a Execução tiver os endpoints de domínio.
Localmente, sem APM, o `traceparent` **não** é enviado (o kit só o gera com tracer ativo) — a
correlação provada é pelo `x-correlation-id`.

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
