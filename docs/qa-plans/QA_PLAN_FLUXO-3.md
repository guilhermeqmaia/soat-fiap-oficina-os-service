# QA Plan — FLUXO 3: OS ponta a ponta (integração, notificações e rastreamento)

> Card do Notion **FLUXO 3** = US-F4-12 (notificações) + US-F4-16 (observabilidade distribuída) +
> fechamento da US-F4-18 (HTTP entre serviços) + BDD ponta a ponta e esqueleto do Cucumber
> (US-F4-13/14/15 no os-service). Planos por story: [`QA_PLAN_US-F4-12.md`](QA_PLAN_US-F4-12.md),
> [`QA_PLAN_US-F4-16.md`](QA_PLAN_US-F4-16.md), [`QA_PLAN_US-F4-18.md`](QA_PLAN_US-F4-18.md).

## Resumo

Valida que a OS atravessa os três serviços por HTTP (RFC-0008) do `POST /ordens-servico` ao
`ENTREGUE`, com compensações, pagamento recusado sem rollback, retry esgotado → saga parada →
reprocessar e idempotência; que o cliente é notificado uma vez por fato; que dá para seguir a OS
por logs/métricas/traces; e que a qualidade é garantida no CI (Sonar ≥ 80 %, contratos, Cucumber
de serviço e ponta a ponta).

**Legenda de dependência**

| Marca | Significa |
|---|---|
| **[LOCAL]** | provado aqui, sem nuvem (testes automatizados e/ou `docker-compose.fase4.yml`) |
| **[STUBS]** | Billing e Execução são os stubs de `e2e/stubs` (seguem o `http-interno.md` e validam contra `docs/contratos/schemas`) — repetir com as **imagens reais** (`BILLING_IMAGE`/`EXECUCAO_IMAGE`, `BDD_E2E_REAIS=1`) quando o Billing mesclar `feat/fluxo-2-billing` e a Execução tiver os endpoints de domínio |
| **[AMBIENTE REAL]** | precisa do EKS com os três serviços e do Datadog — passo a passo em [`docs/fluxo-3/evidencias-pendentes.md`](../fluxo-3/evidencias-pendentes.md) |
| **[ADMIN]** | precisa de configuração de admin no GitHub/SonarCloud (projeto, `SONAR_TOKEN`, branch protection) |

## Pré-requisitos

- Node 22 (Cucumber 13), Docker rodando, `npm ci`, `npx prisma generate`.
- Portas livres para o compose: 3000, 3001, 3002, 8025, 1025 (sobrescrevíveis por `OS_PORT` etc.).
- Ponta a ponta: `npm run e2e:up` (sobe os-service real + Postgres, stubs do Billing/Execução,
  Mailpit) — derrubar com `npm run e2e:down`.
- **[AMBIENTE REAL]**: pré-requisitos dos itens 1–4 de `evidencias-pendentes.md`.
- **[ADMIN]**: projeto no SonarCloud, secret `SONAR_TOKEN`, `SONAR_ORG`/`SONAR_PROJECT_KEY`
  preenchidos em `sonar-project.properties` e no README (seção "Qualidade" do README).

## Cenários de Teste

### TS-01: Notificação ao cliente em cada marco, sem duplicar — [LOCAL] [STUBS]
- **Tipo:** Automatizado
- **DoD:** notificações sem duplicar
- **Precondição:** `NOTIFICATION_PROVIDER=email` com SMTP no Mailpit (compose) ou Nest em memória (BDD serviço)
- **Passos:**
  1. `npm run test:bdd` — cenários `@caminho-feliz`, `@pagamento`, `@idempotencia @notificacao` de `features/ordem-de-servico.feature`
  2. `npm run test:bdd:e2e` — cenários `@caminho-feliz` e "Callback reenviado com o mesmo id não duplica orçamento, notificação nem e-mail" de `features/e2e/ciclo-completo-os.feature`
  3. Unit/integração: `enviar-notificacao.use-case.spec.ts`, `prisma-notificacao.repository.integration.spec.ts` (índice único `(evento_id, tipo, canal)`)
- **Resultado esperado:** um e-mail no Mailpit por marco (`ORCAMENTO_PRONTO`, `ORCAMENTO_APROVADO`, `PAGAMENTO_PENDENTE` com o link do Billing, `PAGAMENTO_APROVADO`, `OS_FINALIZADA`...); callback repetido (mesmo `id`) → `duplicado`, **sem** segunda notificação nem segundo e-mail; nova cobrança (reprocessar) → nova notificação com novo link
- **Alternativo:** dois e-mails para o mesmo fato → violação do índice não está sendo usada como guarda

### TS-02: Notificação é "no máximo uma vez" (sem reenvio automático) — [LOCAL]
- **Tipo:** Automatizado + revisão
- **DoD:** notificações sem duplicar (semântica de entrega)
- **Passos:**
  1. `npm run test:unit -- enviar-notificacao smtp-email-notificador webhook-notificador`
  2. Manual: com o compose no ar, `docker compose -f docker-compose.fase4.yml stop mailpit`, avançar uma OS até `ORCAMENTO_PRONTO`, `docker compose ... start mailpit`; consultar `GET /notificacoes`
- **Resultado esperado:** a notificação é gravada `PENDENTE` **antes** do envio e termina `ENVIADA` ou `FALHOU`; com o SMTP fora, fica `FALHOU` e **não há reenvio automático** — nem quando o SMTP volta, nem quando o mesmo fato chega de novo (a reserva `(evento_id, tipo, canal)` já existe → `Ja notificado`, log `warn`). A saga **não** é afetada pela falha de envio.
- **Decisão registrada:** entrega **no máximo uma vez** por `(fato, tipo, canal)`. Trade-off aceito: um envio que falha se perde (fica visível como `FALHOU` no admin e no portal), em troca de nunca mandar e-mail duplicado ao cliente. Única exceção: o adapter de **webhook** tenta 2 vezes *dentro da mesma chamada*; se a 1ª tentativa der timeout depois de o destino já ter recebido, o destino pode ver 2 POSTs com o mesmo corpo (deduplicar por `numeroOS`+`tipo` no receptor). Reenvio manual/automático de `FALHOU` fica como evolução futura.

### TS-03: Teste manual ponta a ponta — [LOCAL] [STUBS]
- **Tipo:** Manual
- **DoD:** teste manual ponta a ponta
- **Passos:** seguir [`docs/fluxo-3/teste-manual-ponta-a-ponta.md`](../fluxo-3/teste-manual-ponta-a-ponta.md) §1–§12 (caminho feliz, rejeição, pagamento recusado + nova cobrança, cancelamento, retry esgotado + reprocessar, idempotência, divergências de contrato)
- **Resultado esperado:** saídas iguais às coladas no roteiro; `GET /__stub/violacoes` vazio ao final
- **Pendente:** repetir §11 com as imagens reais do Billing/Execução

### TS-04: Trace único atravessando os três serviços — [LOCAL] parcial / [AMBIENTE REAL]
- **Tipo:** Automatizado (parte local) + Manual (Datadog)
- **DoD:** trace único + dashboards
- **Passos:**
  1. [LOCAL] `npm run test:unit -- http-participantes-saga rastreio` e `npx jest --config jest.integration.config.ts ordem-de-servico.e2e -t traceparent`
  2. [LOCAL] roteiro §3.7: logs dos três containers filtrados pelo número da OS
  3. [AMBIENTE REAL] item 1 de `evidencias-pendentes.md` (flame graph `os-service` → `execucao-service` → callback → `os-service` → `billing-service`)
- **Resultado esperado:** local — `x-correlation-id` = número da OS em toda chamada e callback, `traceparent` com o trace do span ativo (APM simulado), logs com `trace_id`/`correlation_id`/`servico`/`rota`/`tentativa`; real — um único trace id no Datadog
- **Limite conhecido:** sem APM local o kit não envia `traceparent`; a junção num único trace só é provável com o Datadog

### TS-05: Dashboard "Oficina — Fluxo distribuído" — [AMBIENTE REAL]
- **Tipo:** Manual
- **DoD:** trace único + dashboards
- **Passos:** item 2 de `evidencias-pendentes.md`
- **Resultado esperado:** painéis com dados (sagas por passo, compensações, p95 e taxa de erro por par origem → destino, callbacks por `type`, sagas paradas > 0 e depois 0); print em `docs/qa-plans/evidencias/US-F4-16-dashboard-<data>.png`
- **Pré-condição de código já provada [LOCAL]:** as métricas existem com os labels do contrato (TS-04 do `QA_PLAN_US-F4-16.md`) e aumentam o esperado por cenário (step "as métricas do OS Service aumentaram" do BDD e2e)

### TS-06: Alertas — [LOCAL] insumo / [AMBIENTE REAL] disparo
- **Tipo:** Automatizado (insumo) + Manual (disparo)
- **DoD:** alertas
- **Passos:**
  1. [LOCAL] `npm run test:bdd:e2e -- --tags @falha-plataforma`: 3 × 5xx → `oficina_http_interno_total{resultado="esgotado"}` +1 e `oficina_os_sagas_paradas` = 1 → reprocessar → 0
  2. [AMBIENTE REAL] item 3 de `evidencias-pendentes.md` (retry esgotado, saga parada com `SAGA_ALERTA_PARADA_MIN=5`)
- **Resultado esperado:** monitor em ALERT com link do runbook ([`docs/runbooks/`](../runbooks/): `retry-esgotado`, `saga-parada` → `saga-reprocessar`, `erros-5xx-por-servico`, `latencia-entre-servicos`, `callback-conflito-repetido`); nenhum alerta de DLQ

### TS-07: Contrato HTTP estável — [LOCAL]
- **Tipo:** Automatizado + revisão
- **DoD:** contrato estável
- **Passos:** conferir o bloco "Status: ESTÁVEL — versão 1.0" em [`docs/contratos/http-interno.md`](../contratos/http-interno.md); `npm run contracts:lint`; `npm run openapi:check`
- **Resultado esperado:** documento marcado estável (versão, data, regra de mudança compatível); lint do OpenAPI sem erro; `os-service.yaml em dia com o codigo`
- **Alternativo:** `openapi:check` falha → controller mudou sem `npm run openapi:export`

### TS-08: Testes de contrato — [LOCAL]
- **Tipo:** Automatizado (CI: passo 1 do `ci-cd.yml`)
- **DoD:** testes de contrato
- **Passos:** `npm run test:contracts`
- **Resultado esperado:** 3 suítes verdes em `test/contracts/`: `callback.provider.contract.spec.ts` (o OS aceita os callbacks das fixtures), `participantes.consumer.contract.spec.ts` (as requisições do `HttpParticipantesSaga` batem com `docs/contratos/schemas`), `envelope.contract.spec.ts`; em execução real, o `After` do BDD e2e reprova se os stubs registraram divergência (`GET /__stub/violacoes`)

### TS-09: `.feature` com Cucumber no CI — [LOCAL] + [ADMIN] (check obrigatório)
- **Tipo:** Automatizado
- **DoD:** `.feature` com Cucumber no CI
- **Passos:** abrir um PR e conferir os jobs `🥒 BDD (Cucumber — serviço)` e `🥒 BDD ponta a ponta (docker-compose.fase4)` do `ci-cd.yml`; baixar os artifacts `cucumber-os-service` e `cucumber-e2e`
- **Resultado esperado:** jobs verdes; relatório HTML (`reports/cucumber/os-service.html`, `e2e.html`) no artifact; em falha do e2e, `e2e-compose.log` junto
- **Localmente:** `npm run test:bdd` (15 cenários) e `npm run e2e:up && npm run test:bdd:e2e` (12 cenários)

### TS-10: Cobertura ≥ 80 % com Sonar — [LOCAL] + [ADMIN]
- **Tipo:** Automatizado
- **DoD:** cobertura ≥ 80 % com Sonar
- **Passos:**
  1. [LOCAL] `npm run test:unit:cov` (Jest falha abaixo de 80 % em linhas, funções, branches e statements) e `npm run test:integration:cov`
  2. [ADMIN] PR com o job `🔎 SonarCloud (quality gate)` verde e badges do README mostrando o gate e a cobertura
- **Resultado esperado:** unit ≥ 80 % nos quatro eixos (11/11/2026: linhas 95,16 %, statements 95,02 %, funções 88,94 %, branches 88,08 %); quality gate "Passed" (cobertura em código novo ≥ 80 %, 0 bugs/vulnerabilidades novas, duplicação < 3 %)
- **Alternativo:** sem `SONAR_TOKEN` ou com os placeholders → o job **falha** com a mensagem do que configurar (não pula)

### TS-11: README + QA plan — [LOCAL]
- **Tipo:** Revisão
- **DoD:** README + QA plan
- **Passos:** ler a seção "Fase 4 — OS Service" do [`README.md`](../../README.md) e este documento
- **Resultado esperado:** README com arquitetura (orquestrador + HTTP + callbacks + notificações + observabilidade), como rodar (local, compose da Fase 4, unit/integração/contrato/BDD/BDD e2e), evidência de cobertura, Swagger, `docs/contratos/openapi`, roteiro manual e runbooks; QA plans FLUXO-3, US-F4-16 e US-F4-18 atualizados

### TS-12: BDD ponta a ponta contra stubs — [LOCAL] [STUBS]
- **Tipo:** Automatizado
- **DoD:** BDD ponta a ponta contra stubs
- **Passos:** `npm run e2e:up && npm run test:bdd:e2e; npm run e2e:down`
- **Resultado esperado:** 12 cenários de `features/e2e/ciclo-completo-os.feature` verdes: caminho feliz até `ENTREGUE`, rejeição com compensação, pagamento recusado + nova cobrança, cancelamento em `EM_DIAGNOSTICO`/`AGUARDANDO_APROVACAO` e recusado depois da execução, 3 cenários de falha de plataforma, 3 de idempotência
- **Com imagens reais:** `BDD_E2E_REAIS=1` pula os `@stub` (restam compensação e cancelamento) — **pendente** das imagens

### TS-13: Esqueleto do Cucumber para os fluxos 1 e 2 — [LOCAL]
- **Tipo:** Revisão
- **DoD:** esqueleto do Cucumber para os fluxos 1 e 2
- **Passos:** seguir "Como os outros serviços copiam o esqueleto" em [`docs/bdd/README.md`](../bdd/README.md) num checkout limpo do Billing (FLUXO 2) e da Execução (FLUXO 1)
- **Resultado esperado:** a tabela "Arquivos a copiar" diz o que copiar como está e o que adaptar (stubs dos participantes, hooks com Postgres/DynamoDB Local, `world.ts`); lista de `.feature` de cada serviço; `npx cucumber-js --dry-run` aponta os steps faltantes. A execução nos outros repos é critério dos FLUXOS 1 e 2

## Casos de Borda
- Callback chega antes de a resposta síncrona ser aplicada → `409`/fora de ordem; o participante repete; a saga ignora o que já passou (sem notificação extra)
- Mesmo fato legítimo repetido (cada pagamento recusado, cada nova cobrança) → **deve** notificar de novo (chave `evento_id` inclui `orderId`)
- Cliente sem e-mail → canal `EMAIL` pulado (log `warn`), saga segue
- `oficina_os_sagas_paradas` só sobe no próximo ciclo do relógio (`SAGA_TIMEOUTS_INTERVALO_MS`; 10 s no compose)
- Fork sem `SONAR_TOKEN` → job SonarCloud falha (aceito: o time trabalha em branches, ADR-0011)
- Portas do compose ocupadas → `e2e:up` falha; usar `OS_PORT`/`BILLING_PORT`/... e `BDD_*_URL`

## Rastreabilidade (Definição de pronto do card FLUXO 3)

| Item da DoD | Cenários | Onde está a prova | Depende de |
|---|---|---|---|
| Notificações sem duplicar | TS-01, TS-02 | `features/ordem-de-servico.feature` (`@notificacao`, `@idempotencia`), `features/e2e/ciclo-completo-os.feature`, `QA_PLAN_US-F4-12.md` | — |
| Teste manual ponta a ponta | TS-03 | `docs/fluxo-3/teste-manual-ponta-a-ponta.md` | imagens reais para o §11 |
| Trace único + dashboards | TS-04, TS-05 | unit/e2e de rastreio; `evidencias-pendentes.md` itens 1–2 | **EKS + Datadog** |
| Alertas | TS-06 | BDD `@falha-plataforma`; `docs/runbooks/`; `evidencias-pendentes.md` item 3 | **EKS + Datadog** (disparo) |
| Contrato estável | TS-07 | `docs/contratos/http-interno.md` (v1.0), `docs/contratos/openapi/` | — |
| `.feature` com Cucumber no CI | TS-09 | jobs `bdd` e `bdd-e2e` do `ci-cd.yml` | admin: check obrigatório |
| Cobertura ≥ 80 % com Sonar | TS-10 | `jest.unit.config.ts` (threshold), job `sonarcloud`, badges | **admin: SonarCloud + `SONAR_TOKEN`** |
| Testes de contrato | TS-08 | `test/contracts/*.contract.spec.ts`, passo 1 do CI | — |
| README + QA plan | TS-11 | `README.md`, este arquivo, `QA_PLAN_US-F4-16.md`, `QA_PLAN_US-F4-18.md` | — |
| BDD ponta a ponta contra stubs | TS-12 | `features/e2e/ciclo-completo-os.feature`, `docker-compose.fase4.yml`, `e2e/stubs/` | imagens reais para a 2ª rodada |
| Esqueleto do Cucumber (fluxos 1 e 2) | TS-13 | `docs/bdd/README.md` | execução nos repos do Billing/Execução |

## Checklist de Validação
- [x] TS-01, TS-02, TS-07, TS-08, TS-12 executados localmente em 11/11/2026 (unit 532, integração 227, contratos 91, BDD serviço 15 cenários, BDD e2e 12 cenários — todos verdes)
- [x] TS-03 roteiro manual com saídas reais (stubs)
- [x] TS-11 README e QA plans
- [x] TS-13 guia de cópia do esqueleto
- [ ] TS-09, TS-10 verdes no primeiro PR depois da configuração de admin (SonarCloud + branch protection)
- [ ] TS-04 (parte real), TS-05, TS-06 (disparo) — **[AMBIENTE REAL]**
- [ ] TS-03 §11 e TS-12 com `BDD_E2E_REAIS=1` — **imagens reais** do Billing/Execução

## Comandos Úteis
```bash
npm run test:unit:cov                 # unit + gate 80 % (coverage/unit/lcov.info)
npm run test:integration:cov          # Testcontainers/Postgres (coverage/integration/lcov.info)
npm run contracts:lint && npm run openapi:check && npm run test:contracts
npm run test:bdd                      # Cucumber nível de serviço
npm run e2e:up && npm run test:bdd:e2e; npm run e2e:down   # Cucumber ponta a ponta
BDD_E2E_REAIS=1 npm run test:bdd:e2e  # com BILLING_IMAGE/EXECUCAO_IMAGE reais
```
