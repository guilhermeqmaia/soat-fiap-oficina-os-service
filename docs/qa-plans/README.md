# Indice de QA Plans

Cobertura de QA Plan por User Story, conforme exigido pelo `CLAUDE.md` ("todo US precisa de QA_PLAN em `docs/qa-plans/`") e pela US-F3-DOC-07. Gerado/atualizado via skill `/qa-plan`.

Legenda: ✅ tem QA Plan · ⚠️ pendente (nao prioritario neste ciclo) · — fora do escopo de QA Plan (historia de documentacao/processo, sem criterio testavel via cenarios de QA)

## Fase 4 — Microsservicos, Saga e Automacao

| Story | Titulo | QA Plan |
|---|---|---|
| US-F4-01 | Kit Compartilhado dos Servicos | ✅ [QA_PLAN_US-F4-01](QA_PLAN_US-F4-01.md) |
| ~~US-F4-02~~ | Mensageria — SNS + SQS FIFO com DLQ (cancelada em 03/11) | ✅ [QA_PLAN_US-F4-02](QA_PLAN_US-F4-02.md) *(historico)* |
| US-F4-03 | Bancos por Servico (Postgres + DynamoDB) | ✅ [QA_PLAN_US-F4-03](QA_PLAN_US-F4-03.md) |
| US-F4-05 | API Gateway Multi-servico | ✅ [QA_PLAN_US-F4-05](QA_PLAN_US-F4-05.md) |
| US-F4-06 | OS Service — strangler | ✅ [QA_PLAN_US-F4-06](QA_PLAN_US-F4-06.md) |
| US-F4-10 | Saga orquestrada | ✅ [QA_PLAN_US-F4-10](QA_PLAN_US-F4-10.md) |
| US-F4-11 | Compensacoes e rollback | ✅ [QA_PLAN_US-F4-11](QA_PLAN_US-F4-11.md) |
| US-F4-18 | Comunicacao HTTP entre servicos (RFC-0008) | ✅ [QA_PLAN_US-F4-18](QA_PLAN_US-F4-18.md) *(plano previo a implementacao)* |

## Fase 3 (`f3-*`) — cobertura completa das historias testaveis

| # | Story | QA Plan |
|---|---|---|
| US-F3-01 | Serverless CPF Authentication (Lambda) | ✅ [QA_PLAN_US-F3-01](QA_PLAN_US-F3-01.md) |
| US-F3-02 | API Gateway + protecao de rotas | ✅ [QA_PLAN_US-F3-02](QA_PLAN_US-F3-02.md) |
| US-F3-03 | App como Resource Server | ✅ [QA_PLAN_US-F3-03](QA_PLAN_US-F3-03.md) |
| US-F3-04 | Terraform: Banco Gerenciado (RDS) | ✅ [QA_PLAN_US-F3-04](QA_PLAN_US-F3-04.md) *(nao implementado ainda — plano serve de guia)* |
| US-F3-05 | Terraform: Cluster Kubernetes (EKS) | ✅ [QA_PLAN_US-F3-05](QA_PLAN_US-F3-05.md) |
| US-F3-06 | Deploy da aplicacao no EKS | ✅ [QA_PLAN_US-F3-06](QA_PLAN_US-F3-06.md) |
| US-F3-07 | Segregacao em 4 repos + branch protection | ✅ [QA_PLAN_US-F3-07](QA_PLAN_US-F3-07.md) *(gap conhecido: falta CODEOWNERS nos 4 repos)* |
| US-F3-08 | CI/CD por repositorio | ✅ [QA_PLAN_US-F3-08](QA_PLAN_US-F3-08.md) |
| US-F3-09 | Logs estruturados + correlacao | ✅ [QA_PLAN_US-F3-09](QA_PLAN_US-F3-09.md) |
| US-F3-10 | Observabilidade: APM, infra, uptime | ✅ [QA_PLAN_US-F3-10](QA_PLAN_US-F3-10.md) *(TS-10 pendente: validacao ao vivo)* |
| US-F3-11 | Dashboards e alertas | ✅ [QA_PLAN_US-F3-11](QA_PLAN_US-F3-11.md) *(TS-13 pendente: demo ao vivo)* |
| US-F3-12 | Entrega: video + PDF + soat-architecture | ✅ [QA_PLAN_US-F3-12](QA_PLAN_US-F3-12.md) |
| US-F3-DOC-01 a 07 | RFCs, ADRs, diagramas, READMEs, indice de docs, este proprio backfill | — (historias de documentacao/processo; validadas por revisao de conteudo, nao por QA Plan) |

**Fase 3: 12/12 historias testaveis com QA Plan (100%).**

## Integração / ponta-a-ponta (cross-story)

Os QA Plans acima validam cada historia isoladamente. Para cobrir riscos que so aparecem na interacao entre historias/repositorios (auth completo, ciclo de vida da OS com falha de integracao, indisponibilidade do banco, ordem de deploy entre repos), ver:

| Escopo | QA Plan |
|---|---|
| Cenarios cross-story (auth ponta-a-ponta, ciclo de OS + webhook, RDS indisponivel, ordem de deploy, idempotencia de webhook) | ✅ [QA_PLAN_INTEGRACAO-F3](QA_PLAN_INTEGRACAO-F3.md) |

Não é exigido pela US-F3-DOC-07 — é uma cobertura extra, priorizada pelos pontos de maior risco de efeito cascata encontrados na investigação de git desta sessão.

## Fase 1 (`US-00` a `US-23`) — backfill parcial, priorizado por risco

| # | Story | Dominio | QA Plan |
|---|---|---|---|
| US-00 | Setup Prisma + PostgreSQL | Infraestrutura | ✅ [QA_PLAN_US-00](QA_PLAN_US-00.md) |
| US-01 | Cadastro de Cliente | Atendimento | ⚠️ pendente |
| US-02 | CRUD completo de Cliente | Atendimento | ⚠️ pendente |
| US-03 | Cadastro de Veiculo | Atendimento | ⚠️ pendente |
| US-04 | Catalogo de Servicos | Catalogo | ✅ [QA_PLAN_US-04](QA_PLAN_US-04.md) |
| US-05 | Catalogo de Produtos | Estoque | ✅ [QA_PLAN_US-05](QA_PLAN_US-05.md) |
| US-06 | Abertura de OS | Atendimento (OS) | ✅ [QA_PLAN_US-06](QA_PLAN_US-06.md) — **backfill (US-F3-DOC-07)** |
| US-07 | Atribuir Mecanico a OS | Atendimento (OS) | ⚠️ pendente — risco medio |
| US-08 | Diagnostico | Atendimento (OS) | ⚠️ pendente — risco medio |
| US-09 | Adicionar Servicos a OS | Atendimento (OS) | ⚠️ pendente — risco medio |
| US-10 | Adicionar Produtos a OS | Atendimento (OS) + Estoque | ⚠️ pendente — risco medio-alto (mexe com reserva de estoque) |
| US-11 | Calculo Automatico do Orcamento | Atendimento (OS) | ✅ [QA_PLAN_US-11](QA_PLAN_US-11.md) — **backfill (US-F3-DOC-07)** |
| US-12 | Envio de Orcamento para Aprovacao | Atendimento (OS) | ⚠️ pendente — risco medio |
| US-13 | Aprovacao/Rejeicao do Orcamento | Atendimento (OS) | ✅ [QA_PLAN_US-13](QA_PLAN_US-13.md) — **backfill (US-F3-DOC-07)** |
| US-14 | Execucao do Servico | Atendimento (OS) | ✅ [QA_PLAN_US-14](QA_PLAN_US-14.md) |
| US-15 | Finalizacao e Entrega | Atendimento (OS) | ⚠️ pendente — risco medio |
| US-16 | Acompanhamento de OS pelo Cliente | Atendimento (OS) | ⚠️ pendente — risco baixo/medio |
| US-17 | Listagem de OS + Tempo Medio | Atendimento (OS) | ⚠️ pendente — risco baixo/medio |
| US-18 | Controle de Estoque | Estoque | ✅ [QA_PLAN_US-18](QA_PLAN_US-18.md) |
| US-19 | Autenticacao JWT (legado — substituida na Fase 3) | Autenticacao | ✅ [QA_PLAN_US-19](QA_PLAN_US-19.md) *(ver US-F3-03 para o comportamento pos-Fase 3)* |
| US-20 | Notificacao ao Cliente | Notificacao | ✅ [QA_PLAN_US-20](QA_PLAN_US-20.md) |
| US-21 | Docker e Infraestrutura | Infraestrutura | ⚠️ pendente — risco baixo (validado indiretamente pelo CI/CD) |
| US-22 | Testes Automatizados (80% cobertura) | Todos | ⚠️ pendente — meta-story (o proprio gate de cobertura e a validacao) |
| US-23 | Documentacao Swagger | Todos | ⚠️ pendente — risco baixo |

**Fase 1: 10/23 historias com QA Plan** (7 originais + 3 do backfill: US-06, US-11, US-13).

## Fase 2 (`f2-*`) — backfill parcial, priorizado por risco

| # | Story | QA Plan |
|---|---|---|
| f2-01 | Listagem de OS com ordenacao | ⚠️ pendente — risco baixo |
| f2-02 | Webhook de Aprovacao de Orcamento (inbound) | ✅ [QA_PLAN_US-F2-02](QA_PLAN_US-F2-02.md) — **backfill (US-F3-DOC-07)** |
| f2-03 | Webhook de Notificacao de Status (outbound) | ✅ [QA_PLAN_US-F2-03](QA_PLAN_US-F2-03.md) — **backfill (US-F3-DOC-07)** |
| f2-04 | Revisao de containerizacao | ⚠️ pendente — risco baixo (infra) |
| f2-05 | Manifestos Kubernetes | ⚠️ pendente — coberto indiretamente por US-F3-06 |
| f2-06 | Terraform IaC (legado, pre-Fase 3) | ⚠️ pendente — superado pelas US-F3-04/05 |
| f2-07 | CI/CD completo (legado) | ⚠️ pendente — superado pela US-F3-08 |
| f2-08 | Arquitetura/README (legado) | ⚠️ pendente — superado pela US-F3-DOC-05/06 |
| f2-09 | Entrega video/PDF (legado) | ⚠️ pendente — superado pela US-F3-12 |
| f2-10 | Refatoracao Clean Architecture | ⚠️ pendente — risco medio (estrutural, coberto indiretamente por `architecture.spec.ts`) |
| f2-11 | Testes de carga e escalabilidade | ⚠️ pendente — validado pelos scripts `perf/` e pelo QA Plan da US-F3-05 (HPA) |

**Fase 2: 2/11 historias com QA Plan** (as duas integracoes webhook, escolhidas por serem o maior risco de efeito cascata em producao).

## Justificativa da priorizacao (backfill)

Conforme a nota da US-F3-DOC-07 ("nao precisa cobrir 100% das historias antigas de uma vez; priorizar por risco"), o backfill deste ciclo cobriu:

- **US-06, US-11, US-13** — o nucleo do fluxo financeiro/estado da OS (abertura, calculo de orcamento, aprovacao/recusa com estorno de estoque). Sao as transicoes com maior impacto se falharem (dinheiro, estoque, cancelamento indevido) e alimentam diretamente o alerta "falha no processamento de ordens de servico" da US-F3-11.
- **f2-02, f2-03** — as duas integracoes via webhook (inbound e outbound), que sao a superficie com maior risco de efeito cascata externo (autenticacao propria, timeouts, dependencia de terceiros) e alimentam a metrica/alerta de "erros de integracao".
- **Auth (US-19) e Estoque (US-18)** ja tinham QA Plan antes deste backfill — por isso nao entraram na lista, apesar de serem dominios criticos citados na US-F3-DOC-07.

O que ficou pendente (US-01/02/03/07/08/09/10/12/15/16/17/21/22/23 e a maioria de `f2-*`) sao majoritariamente CRUDs mais simples ou historias ja superadas/cobertas indiretamente por outra US da Fase 3 — risco menor o suficiente para nao justificar o esforco neste ciclo. Recomenda-se revisitar esta lista se sobrar tempo antes da entrega, priorizando US-10 (mexe com estoque) e US-12 (fecha o ciclo antes da aprovacao) como proximos candidatos.
