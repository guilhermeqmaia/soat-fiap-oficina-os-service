# FLUXO 3 — OS ponta a ponta: diagnóstico inicial (10/11/2026)

Escopo do card (manifesto `docs/user-stories/f4-notion-import.md` + `docs/dashboard-fase-4.html`):
**US-F4-12** (notificações pelos callbacks), **US-F4-16** (trace único, dashboards, alerta de saga parada),
**fechamento da US-F4-18** (teste com os 3 serviços) e **qualidade embutida** no os-service
(US-F4-13 cobertura + Sonar, US-F4-14 BDD ponta a ponta + esqueleto do Cucumber, US-F4-15 contrato).

> **Fonte da "Definição de pronto".** O texto do card no Notion não está no repositório e o conector
> Notion desta sessão não acessa o board (`object_not_found` no database `33a48f0b-…`). A lista abaixo
> foi montada a partir dos critérios de aceite das stories (f4-12, f4-13, f4-14, f4-15, f4-16, f4-18), da
> linha do FLUXO 3 no manifesto e do card no dashboard. **Vale conferir com o card do Notion** se há item
> extra lá.

Nada de código foi alterado; só este arquivo foi criado.

---

## 1. Testes e cobertura atual (`main` @ `7cb0165`)

Comandos: `npm ci`, `npx prisma generate`, `npm run test:unit:cov`, `npm run test:integration -- --coverage`
(Testcontainers com Postgres 16, Docker local).

| Suite | Resultado | Statements | Branches | Functions | Lines |
|---|---|---|---|---|---|
| Unit (`jest.unit.config.ts`) | ✅ 66 suites, **463/463** testes, 29 s | **94,40%** | **84,53%** | **87,58%** | **94,59%** |
| Integração + e2e (`jest.integration.config.ts`) | ✅ 13 suites, **210/210** testes, 108 s | **93,15%** | **82,90%** | **96,38%** | **93,66%** |

- Os dois configs têm `coverageThreshold` global de 80% nas 4 métricas — ambos passam.
- A cobertura de integração só mede `**/infrastructure/prisma-*.repository.ts`. Pontos fracos nela:
  `prisma-notificacao.repository.ts` (47% linhas, 0% branches — nenhum teste de integração do repositório
  de notificação) e `prisma-callbacks-processados.repository.ts` (0% branches, linhas 20-21: caminho de
  id duplicado / violação de unique). Os dois serão tocados pelo FLUXO 3.
- Branches (84,5% unit) é a métrica com menos folga para o código novo.
- `npm ci` avisa sobre `allow-scripts` pendentes (Prisma, bcrypt etc.) e vulnerabilidades no `npm audit`;
  não impede build nem testes.

---

## 2. Definição de pronto × código

Legenda: ✅ pronto · 🟡 parcial · ❌ falta · ⛔ bloqueado por fator externo

### 2.1 US-F4-12 — Notificações ao cliente a partir dos eventos

| Item | Status | Arquivos | O que falta |
|---|---|---|---|
| Listener in-process reage a `billing.orcamento-gerado`, `orcamento-aprovado`, `cobranca-criada`, `pagamento-aprovado`, `pagamento-recusado` e às transições `FINALIZADA`/`CANCELADA` | 🟡 | `src/notificacao/application/listeners/ordem-de-servico.listener.ts`, `src/ordem-de-servico/application/use-cases/transicoes/*.ts`, `src/ordem-de-servico/saga/application/orquestrador-saga.service.ts` | O listener só ouve `OrcamentoProntoEvent` (≈ orcamento-gerado, emitido na transição para AGUARDANDO_APROVACAO), `OsFinalizadaEvent` (≈ pagamento-aprovado) e `OsStatusAlteradoEvent` (genérico, cobre CANCELADA/EM_EXECUCAO/AGUARDANDO_PAGAMENTO com texto genérico). **Nenhum fato `billing.*` é republicado no `EventEmitter`**: `orcamento-aprovado` e `cobranca-criada` não mudam o status da OS e `pagamento-recusado` só grava histórico na saga, então hoje esses três não geram notificação. Falta o orquestrador emitir os fatos (após o commit) e o listener tratá-los. |
| Mensagem com `linkPagamento` vinda da resposta `201` de `POST /orcamentos/{n}/cobrar` | ❌ | `src/ordem-de-servico/saga/infrastructure/http-participantes-saga.ts`, `src/ordem-de-servico/saga/domain/saga-os.entity.ts` (case `billing.cobranca-criada`) | O corpo da resposta já chega ao evento da saga (`data.linkPagamento`, ver `src/test/fake-participantes-saga.ts:77`), mas a saga só usa `orderId` no histórico; o link não é persistido, emitido nem posto na mensagem "serviço concluído, pague para retirar". |
| Canais webhook (HMAC) e e-mail; `GET /clientes/:cpf/notificacoes` inalterado; `GET /notificacoes` (ADMIN/ATENDENTE) | ✅ (com ressalva) | `src/notificacao/infrastructure/webhook-notificador.adapter.ts` (HMAC `X-Signature: sha256=…`), `smtp-email-notificador.adapter.ts`, `cliente-notificacao.controller.ts`, `notificacao.controller.ts`, `notificacao.module.ts` | Endpoints e adapters existem. Ressalvas: o canal é escolhido por `NOTIFICATION_PROVIDER` (um só por vez, não os dois) e o enum `CanalNotificacao` só tem `EMAIL` (ver divergências). A resposta do `GET` não tem `linkPagamento`. |
| Idempotente: uma notificação por `id` do envelope | 🟡 | `src/ordem-de-servico/saga/application/receber-callback.use-case.ts`, `prisma-callbacks-processados.repository.ts`, `registrar-transicao.base.ts` | A dedup dos callbacks em `processed_messages` e o "já está no status alvo → não publica" em `registrarTransicao` cobrem callback repetido. **Não há** `evento_id` nem unique `(tipo, OS)` na tabela `notificacao`. **Risco:** os eventos de domínio são publicados *dentro* da transação (o `EventEmitterDomainEventPublisher` do kit faz `emit` síncrono) e o `aplicarComRetry` do orquestrador refaz a transação em `ConcurrentModificationError`. Uma tentativa revertida já disparou o listener, o que pode gerar notificação fantasma ou duplicada. A story pede emissão **após o commit**. Falta um teste que prove isso. |
| Tabela `notificacao` com `numero_os`, `tipo` (7 tipos), `link_pagamento`, `evento_id`, `canal` e-mail/webhook | ❌ | `prisma/schema.prisma` (`model Notificacao`, `enum TipoNotificacao`) | Hoje: `ordem_de_servico_id`, 3 tipos (`ORCAMENTO_PRONTO`, `OS_FINALIZADA`, `STATUS_OS_ALTERADO`), sem `link_pagamento`/`evento_id`/`numero_os`. Precisa de migration (colunas e valores de enum novos; a story diz "nenhuma tabela nova", o que continua valendo). |
| QA Plan da story | ❌ | `docs/qa-plans/` | Não existe `QA_PLAN_US-F4-12.md`. |

### 2.2 US-F4-16 — Observabilidade distribuída (lado OS + infra)

| Item | Status | Arquivos | O que falta |
|---|---|---|---|
| `traceparent` e `x-correlation-id` em toda chamada e callback; servidor continua o trace | 🟡 | kit 0.3.0 `dist/http/cliente-http-interno.js` (injeta os dois; `traceparent` só com APM ativo), `dist/logging/tracer-bridge.js`, `http-participantes-saga.ts` (`correlationId = numeroOS`) | No lado OS o código existe. Falta comprovar o trace único OS → Execução/Billing → callback com o `dd-trace` ativo (span `http.client` filho do caso de uso) e tirar o screenshot. Depende dos outros serviços e do Datadog. |
| Logs JSON com `trace_id`, `correlation_id`, `servico`, `rota`, `tentativa` | 🟡 | kit `logging` (pino), logs estruturados no orquestrador/participantes | `tentativas` só aparece no log de falha (`comando nao entregue`); falta conferir `servico`/`rota` nos logs da chamada de saída e logar cada tentativa. |
| Métricas `oficina_http_interno_duracao_seconds`, `oficina_http_interno_total{…resultado=sucesso\|recusa\|esgotado}`, `oficina_callbacks_total{type,resultado}` | ❌ | `src/observabilidade/metrics.registry.ts`; kit 0.3.0 só tem `oficina_http_request_duration_seconds` | Nenhuma das três existe. Hoje há `oficina_integracoes_total{integracao,resultado=sucesso\|recusado\|falha}` e `oficina_os_saga_passos_total`. A story diz que são "do kit", o que exige release do kit (ver bloqueios). Alternativa: criar no os-service primeiro. |
| Gauge `oficina_os_sagas_paradas` + `SAGA_ALERTA_PARADA_MIN` | ✅ | `metrics.registry.ts`, `saga-timeouts.service.ts` | — |
| Dashboard "Oficina — Fluxo distribuído" (sagas por passo, tempo por passo, compensações, p95/erro por par origem→destino, callbacks por type, sagas paradas) + painel por serviço | ❌ | `soat-fiap-oficina-infra-k8s/observability/dashboards.tf` | Os dashboards da Fase 3 não têm nada de saga ou de chamadas entre serviços. |
| Alertas: saga parada, retry esgotado, 5xx por serviço, p95 entre serviços > 2 s, `409` repetido em callback, assinatura do MP | ❌ | `soat-fiap-oficina-infra-k8s/observability/monitors.tf` | Só existem os 5 monitores da Fase 3 (5xx em `/ordens-servico*`, falha de notificação, p95 > 500 ms, CPU, CrashLoop). |
| Runbooks por alerta | 🟡 | `docs/runbooks/saga-reprocessar.md` | Só o de saga parada existe; faltam os runbooks dos outros alertas novos. |
| Evidência no QA Plan (trace atravessando os 3 serviços + dashboard) | ⛔ | — | Não existe `QA_PLAN_US-F4-16.md`. Depende dos 3 serviços no ar com Datadog. |

### 2.3 US-F4-18 — fechamento (lado OS Service + hub)

| Item | Status | Arquivos | O que falta |
|---|---|---|---|
| Orquestrador chama Execução/Billing pelo cliente HTTP do kit **após o commit** e converte `201`/`200`/`409` em eventos | ✅ | `orquestrador-saga.service.ts` (`executarComandos`), `http-participantes-saga.ts` (`rotaDoComando`) | — |
| `POST /ordens-servico/{numero}/eventos` (`SERVICO`): envelope, dedup por `id`, `200 {aplicado,passo,status}`, `404`, `409` | ✅ | `callback-saga.controller.ts`, `dto/envelope-callback.dto.ts`, `receber-callback.use-case.ts`; e2e em `ordem-de-servico.e2e.spec.ts:197-287` | A validação é por DTO (class-validator), não contra o schema do `asyncapi.yaml` (isso é da US-F4-15). |
| Remoção de outbox/poller/consumer/handlers, vars SNS/SQS, LocalStack | ✅ | migration `20261104000000_remove_outbox`; nenhuma ocorrência de `SNS_TOPIC_ARN`/`SQS_QUEUE_URL`/`localstack` fora de `docs/`; `docker-compose.yml` só com Postgres; README com a seção "Comunicação entre serviços" | — |
| Retry esgotado: histórico `chamada-falhou` com tentativas, saga parada, `reprocessar`, métrica `oficina_os_http_interno_total{servico,rota,resultado}` | 🟡 | `orquestrador-saga.service.ts:126-158`, `saga-admin.controller.ts`, e2e `:454` | `reprocessar` e saga parada funcionam (e2e). Mas o esgotamento vira label `comando-falhou` em `oficina_os_saga_passos_total` + log; **não entra no histórico da saga** (sem `chamada-falhou`/`tentativas`) e a métrica tem outro nome. |
| Notificação in-process alimentada pelos `billing.*` | ❌ | — | Mesmo item da US-F4-12. |
| Testes: unit do orquestrador (sucesso/409/5xx/esgotado) e e2e do callback (válido/duplicado/404/409/403) | ✅ | `orquestrador-saga.service.spec.ts`, `http-participantes-saga.spec.ts`, `ordem-de-servico.e2e.spec.ts` | — |
| Hub: `docker-compose.fase4.yml` sem LocalStack (3 serviços, 2 Postgres, DynamoDB Local, mock MP, Lambda local) | ❌ | — | O arquivo não existe. É pré-requisito do BDD ponta a ponta. |
| Hub: `docs/contratos/openapi/` com o OpenAPI de cada serviço | ❌ | `docs/contratos/openapi/README.md` | Só o README. |
| QA_PLAN_US-F4-18 executado com os 3 serviços (retry, callback idempotente, `409`, JWT cruzado) | ⛔ | `docs/qa-plans/QA_PLAN_US-F4-18.md` | O plano existe. A execução depende dos endpoints da Execução e do merge do Billing. |

### 2.4 Qualidade embutida no os-service (US-F4-13 / 14 / 15)

| Item | Status | Arquivos | O que falta |
|---|---|---|---|
| Jest `coverageThreshold` 80% (linhas, funções, branches) | ✅ | `jest.unit.config.ts`, `jest.integration.config.ts` | — |
| Testes de domínio puros (entidades, máquina de estados, orquestrador) | ✅ | `saga-os.entity.spec.ts`, `orquestrador-saga.service.spec.ts`, specs de domínio | — |
| Integração com Testcontainers (Postgres) | ✅ | `src/test/database.container.ts`, `*.integration.spec.ts`, `*.e2e.spec.ts` | Faltam testes de integração do `prisma-notificacao.repository.ts`. |
| `sonar-project.properties`, análise em PR e `main`, quality gate (cobertura nova ≥ 80%, 0 bugs/vulns novos, duplicação < 3%) | 🟡 | `sonar-project.properties`, `.github/workflows/ci-cd.yml`, `infra/sonar/` | O arquivo aponta para o SonarQube local (`projectKey=tech-challenge`, sem `sonar.organization`). O CI não tem passo de SonarCloud nem check de quality gate. O "coverage gate" do CI faz grep no HTML do lcov (frágil e redundante, porque o Jest já falha abaixo de 80%). |
| Badge do quality gate e da cobertura no README | ❌ | `README.md:3` | Só há badges de CI/CD, CD AWS e perf. |
| `@cucumber/cucumber` + `ts-node`, `npm run test:bdd`, Gherkin `# language: pt`, steps com `mintToken`/`mintServiceToken` | ❌ | `package.json` | Sem dependência, script ou pasta `features/`. |
| `.feature` do OS Service: `abrir-os.feature`, `entrega.feature` + a parte OS de `aprovacao`, `cobranca`, `pagamento`, `rejeicao`, `cancelamento`, com Billing/Execução mockados por HTTP (nock/WireMock) | ❌ | — | Os cenários equivalentes já existem como e2e Jest (`ordem-de-servico.e2e.spec.ts`), e o `src/test/fake-participantes-saga.ts` pode virar base dos steps. Falta escrever em Gherkin. |
| **Ponta a ponta no hub** `e2e/features/ordem-de-servico-completa.feature` (feliz, rejeição com compensação, idempotência), polling sem `sleep` | ❌ / ⛔ | — | Depende do `docker-compose.fase4.yml` e da Execução com endpoints. |
| Esqueleto do Cucumber para os fluxos 1 e 2 copiarem | ❌ | — | Ainda não existe. É o primeiro entregável que destrava os outros fluxos. |
| Job `bdd` no CI do serviço, `bdd.yml` no hub com `repository_dispatch` + nightly, relatório HTML como artifact | ❌ | `.github/workflows/` | Ainda não existe. |
| `npm run openapi:export` → `docs/contratos/openapi/os-service.yaml` com `info.version` | ❌ | — | Ainda não existe. |
| Lint de OpenAPI bloqueante (redocly/spectral) | ❌ | — | Ainda não existe. |
| Testes de contrato (`supertest` + `jest-openapi`) das respostas e do callback | ❌ | — | Ainda não existe. |
| Callback validado na entrada contra o schema (`400` com motivo, nunca entra em `processed_messages`) | 🟡 | `dto/envelope-callback.dto.ts`, `callback-saga.controller.ts` | Já devolve `400` por DTO inválido e por `data.numeroOS` divergente do path, antes da dedup. Falta validar o `data` por `type` contra o `asyncapi.yaml`. |

---

## 3. Divergências entre stories e código

| # | Tema | Story / contrato | Código | Sugestão |
|---|---|---|---|---|
| D1 | Métrica das chamadas internas | US-F4-18: `oficina_os_http_interno_total{servico,rota,resultado}`. US-F4-16: `oficina_http_interno_total{origem,destino,rota,resultado=sucesso\|recusa\|esgotado}` + `oficina_http_interno_duracao_seconds` | `oficina_integracoes_total{integracao,resultado=sucesso\|recusado\|falha}` | As duas stories divergem até entre si. Adotar a da US-F4-16 (no kit) e manter `oficina_integracoes_total` por compatibilidade com o monitor da Fase 3. |
| D2 | Métrica de callbacks | `oficina_callbacks_total{type,resultado=aplicado\|duplicado\|conflito\|erro}` | não existe | Criar no `ReceberCallbackUseCase`/controller. |
| D3 | Retry esgotado no histórico | US-F4-18: histórico `chamada-falhou` com `tentativas` | só label `comando-falhou` em `oficina_os_saga_passos_total` + log | Registrar no histórico da saga (vale também para o `GET …/saga` e o BDD). |
| D4 | Tipos de notificação | `ORCAMENTO_PRONTO`, `ORCAMENTO_APROVADO`, `PAGAMENTO_PENDENTE`, `PAGAMENTO_APROVADO`, `PAGAMENTO_RECUSADO`, `OS_FINALIZADA`, `OS_CANCELADA` | `ORCAMENTO_PRONTO`, `OS_FINALIZADA`, `STATUS_OS_ALTERADO` | Adicionar os 5 que faltam. Decidir se `STATUS_OS_ALTERADO` (Fase 2) continua; a story não o cita. |
| D5 | Colunas de `notificacao` | `numero_os`, `link_pagamento`, `evento_id` (unique tipo+OS), `criado_em`, status `enviada/falhou` | `ordem_de_servico_id`, sem link/evento_id, `created_at`, status `PENDENTE/ENVIADA/FALHOU` | Adicionar `numero_os`, `link_pagamento`, `evento_id` + unique. Manter `created_at` e o enum atual (é só nomenclatura da story). |
| D6 | Canal | "e-mail/webhook" | enum `CanalNotificacao` só tem `EMAIL`. O provider (webhook **ou** e-mail) vem de `NOTIFICATION_PROVIDER`, e a notificação via webhook é gravada com canal `EMAIL` | Adicionar `WEBHOOK` ao enum e gravar o canal real. |
| D7 | Momento da emissão | US-F4-12: emitir no `EventEmitter` **após o commit** | eventos publicados dentro da transação (`registrarTransicao` → `publish` síncrono), com risco em retry de conflito | Acumular os eventos na transação e publicar depois do `uow.executar`. |
| D8 | Payload do webhook | `{ numeroOS, tipo, mensagem, linkPagamento? }` | `{ ordemId, clienteId, statusAnterior, statusAtual, timestamp, tipoNotificacao }` (`webhook-notificador.adapter.ts:78`), sem `numeroOS`, `mensagem` e `linkPagamento`; retry de 2 tentativas | Acrescentar `numeroOS`, `mensagem` e `linkPagamento?` (campos aditivos, sem quebrar quem consome hoje). |
| D13 | Variável do webhook | `NOTIFICACAO_WEBHOOK_URL` | `NOTIFICATION_WEBHOOK_URL` / `NOTIFICATION_WEBHOOK_SECRET` | Manter o código e corrigir a story (só nomenclatura). |
| D9 | Rotas | `http-interno.md`: `POST /ordens-servico/{id}/entregar` (por id) | igual (`:id`, UUID); callback por `:numero` | Sem divergência. Atenção nos steps BDD: entrega usa **id**, callback e status usam **número**. |
| D10 | Sonar | ADR-0011: SonarCloud com quality gate obrigatório | `sonar-project.properties` de SonarQube local, sem passo no CI | Ver bloqueios. |
| D11 | Docs do fluxo de notificação | f4-12 "Atenção" ainda fala em `OsStatusAlteradoEvent` e fila `notificacao-eventos` | fila já removida | Atualizar o texto ao fechar a US-F4-12. |
| D12 | Título da US-F4-16 no manifesto | manifesto: "Traces através das Mensagens … Alertas de Fila" | story reescrita (HTTP, sem fila) | Atualizar o título no manifesto/Notion. |

---

## 4. Bloqueios e dependências externas

| # | Bloqueio | Impacto no FLUXO 3 | Quem destrava |
|---|---|---|---|
| B1 | **Execução Service sem endpoints de domínio.** `origin/main` (`352579d`) só tem o template (`GET /t/privado`) e não há branch de feature remota | Teste manual com os 3 serviços, BDD ponta a ponta, contrato real e trace atravessando a Execução | FLUXO 1 |
| B2 | **Billing com endpoints só na branch** `feat/fluxo-2-billing` (`POST /orcamentos`, `/{n}/cobrar`, `/aprovar`, `/rejeitar`, `DELETE`, webhook MP, `linkPagamento` na view), ainda sem merge na `main` | Mesmo do B1 para o lado Billing; o formato do `201` do `cobrar` precisa casar com o `linkPagamento` esperado aqui | FLUXO 2 |
| B3 | **Kit sem as métricas `http_interno`/`callbacks`.** A story as coloca no kit (`@guilhermeqmaia/oficina-kit` 0.3.0 instalado) | Exige PR + release minor no repo do kit (GitHub Packages) e bump nos 3 serviços. Alternativa: criar no os-service e migrar depois | dono do kit / time |
| B4 | **SonarCloud:** organização/projeto no SonarCloud, secret `SONAR_TOKEN` no repo e quality gate como check obrigatório na branch protection | Item da US-F4-13 e badge no README | admin do repo / org `guilhermeqmaia` |
| B5 | **Datadog:** `DD_API_KEY`/`DD_APP_KEY` para o `terraform apply` de `observability/` no infra-k8s e cluster EKS ligado ("religar o EKS" está no plano) | Dashboards, monitores e evidências (screenshots) da US-F4-16 | infra / time |
| B6 | **CI do hub:** um PAT (secret) para `repository_dispatch` dos serviços → hub (`bdd.yml`) | Execução do BDD ponta a ponta a cada PR dos serviços | admin dos repos |
| B7 | **Mercado Pago:** o e2e usa mock no compose (sem bloqueio). Teste manual real depende das credenciais sandbox já no card do FLUXO 2 | Só o teste manual de pagamento | FLUXO 2 |
| B8 | **E-mail:** Brevo (credenciais) ou Ethereal (sem bloqueio) | Só a evidência de e-mail real | opcional |
| B9 | **Notion:** o conector desta sessão não acessa o board | Não deu para conferir o texto literal da DoD do card | Gabriel (conferir manualmente) |

---

## 5. Ordem sugerida (sem depender dos bloqueios)

1. **Esqueleto do Cucumber** no os-service (`features/`, `test:bdd`, steps com `mintServiceToken` + mock HTTP dos participantes) com `abrir-os.feature` e `entrega.feature`. Destrava os fluxos 1 e 2.
2. **US-F4-12:** emitir os fatos após o commit (corrige D7), novos tipos e colunas (D4–D6, migration), `linkPagamento` vindo do `cobranca-criada`, dedup por `evento_id` e testes de integração do repositório de notificação.
3. **Métricas e histórico:** `chamada-falhou` no histórico (D3) e as métricas de D1/D2 (no os-service, ou no kit se a release sair a tempo).
4. **Contrato:** `openapi:export` + lint + `jest-openapi` no os-service.
5. **SonarCloud no CI** assim que o B4 for destravado.
6. Com B1/B2 resolvidos: `docker-compose.fase4.yml`, BDD ponta a ponta no hub, QA_PLAN_US-F4-18 executado, dashboards/alertas (B5) e as evidências.
