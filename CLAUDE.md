# Auto Repair Shop Integrated System - Tech Challenge FIAP

## About the project

Back-end MVP for a mid-size auto repair shop system, focused on service order management, clients, vehicles, and parts. Built with NestJS using Domain-Driven Design (DDD), PostgreSQL via Prisma ORM.

**Stack:** NestJS + TypeScript + Prisma + PostgreSQL + Docker
**Architecture:** Layered monolith following tactical DDD

## DDD Documentation (Miro)

The full Event Storming is on the Miro board (ID: `uXjVGwyI88w=`).
The latest version is **Event Storming v3 (30/03)**.

### Bounded Contexts

- **Atendimento** — Cliente, Veiculo, OrdemDeServico (aggregate root)
- **Catalogo** — Servico
- **Estoque** — Produto (parts and supplies), stock movements
- **Autenticacao** — Usuario, JWT
- **Notificacao** — client alert delivery (in-process in the OS Service, fed by the HTTP callbacks)

Fase 4 split: **OS Service** (this repo: Atendimento + saga orchestrator + Notificacao, Postgres `oficina_os`),
**Billing Service** (Orcamento, Pagamento/Mercado Pago, ledger, Postgres `oficina_billing`),
**Execucao Service** (execution queue, diagnosis, Catalogo + Estoque, DynamoDB `oficina-execucao`).
Services talk over **direct HTTP** (RFC-0008, 2026-11-03): the orchestrator calls Execucao/Billing
endpoints with retry; they call back `POST /ordens-servico/{numero}/eventos`. Contract:
`docs/contratos/http-interno.md`. No SNS/SQS, outbox or DLQ (RFC-0006/ADR-0009 superseded).

### Actors

- **Cliente** — approves/rejects budget, tracks OS
- **Atendente** — registers client, opens OS, delivers vehicle
- **Mecanico** — diagnoses, adds services/products, executes
- **Gestor** — manages catalogs, monitors KPIs
- **Sistema** — calculates budget, transitions status, notifies

### Service Order Flow (state machine)

```
RECEBIDA -> EM_DIAGNOSTICO -> AGUARDANDO_APROVACAO -> EM_EXECUCAO -> AGUARDANDO_PAGAMENTO -> FINALIZADA -> ENTREGUE
                                      |
                                      v
                                  CANCELADA (only RECEBIDA / EM_DIAGNOSTICO / AGUARDANDO_APROVACAO)
```

Fase 4 (decision of 2026-11-03): the customer is charged **after** the service is
executed. Callback `execucao.finalizada` -> AGUARDANDO_PAGAMENTO + `POST /orcamentos/{n}/cobrar`
(≙ `billing.cobrar`); the `201` response (≙ `billing.cobranca-criada`) carries the payment link;
callback `billing.pagamento-aprovado` -> FINALIZADA. Declined/late payment keeps the OS in
AGUARDANDO_PAGAMENTO (no rollback). Transport between services is HTTP (RFC-0008); the
`execucao.*`/`billing.*` names are vocabulary (`docs/contratos/http-interno.md`).

**Automatic transitions (Policies):**
- Mechanic assigns themselves to OS -> status changes to EM_DIAGNOSTICO
- Mechanic completes budget -> AGUARDANDO_APROVACAO + notifies client
- Client approves (callback `billing.orcamento-aprovado`) -> `POST /execucao/ordens/{n}/iniciar`; EM_EXECUCAO on `200` (≙ `execucao.iniciada`)
- Execution finished -> AGUARDANDO_PAGAMENTO + `billing.cobrar`; payment approved -> FINALIZADA
- Client rejects -> CANCELADA + reverses inventory reservations
- All services completed -> AGUARDANDO_PAGAMENTO (charge); payment approved -> FINALIZADA
- When execution starts -> inventory deduction for products

## User Stories

User stories are in `docs/user-stories/` and also on the Notion board (Tech Challenge Board).

### Sprint 1 — Foundation + Independent CRUDs (19 SP)

| # | Story | SP | Module |
|---|---|---|---|
| US-00 | Setup Prisma + PostgreSQL | 5 | Infrastructure |
| US-21 | Docker and Infrastructure | 3 | Infrastructure |
| US-01 | Client Registration | 3 | Atendimento |
| US-04 | Service Catalog | 3 | Catalogo |
| US-05 | Product Catalog | 5 | Estoque |

### Sprint 2 — Complementary CRUD + OS Opening

| # | Story | SP | Module |
|---|---|---|---|
| US-02 | Full Client CRUD | 3 | Atendimento |
| US-03 | Vehicle Registration | 3 | Atendimento |
| US-06 | Service Order Opening | 5 | Atendimento |
| US-19 | JWT Authentication | 5 | Autenticacao |

### Sprint 3 — OS Flow (diagnosis to approval)

| # | Story | SP | Module |
|---|---|---|---|
| US-07 | Assign Mechanic to OS | 2 | Atendimento |
| US-08 | Diagnosis | 3 | Atendimento |
| US-09 | Add Services to OS | 3 | Atendimento |
| US-10 | Add Products to OS | 5 | Atendimento + Estoque |
| US-11 | Automatic Budget Calculation | 3 | Atendimento |
| US-12 | Complete and Send Budget | 3 | Atendimento |

### Sprint 4 — Execution, delivery, and extras

| # | Story | SP | Module |
|---|---|---|---|
| US-13 | Budget Approval/Rejection | 5 | Atendimento |
| US-14 | Service Execution | 5 | Atendimento |
| US-15 | Completion and Delivery | 2 | Atendimento |
| US-16 | Client OS Tracking | 3 | Atendimento |
| US-18 | Inventory Control | 5 | Estoque |

### Sprint 5 — Monitoring, tests, and finalization

| # | Story | SP | Module |
|---|---|---|---|
| US-17 | OS Listing + Average Time Monitoring | 5 | Atendimento |
| US-20 | Client Notification | 3 | Notificacao |
| US-22 | Automated Tests (80% coverage) | 8 | All |
| US-23 | Swagger Documentation | 2 | All |

### Fase 2 — Quality, Resilience & Scalability (`f2-*`)

Refactor to Clean Architecture, API tweaks, webhook notification, Docker review,
Kubernetes manifests, Terraform (cluster + DB), CI/CD and load tests. Stories in
`docs/user-stories/f2-*.md`. Plan: `docs/plano-execucao-fase-2.md`.

### Fase 3 — Cloud, Security & Observability (`f3-*`)

Serverless CPF auth + API Gateway, AWS cloud infra (EKS/RDS via Terraform),
4-repo split with per-repo CI/CD, observability, and formal architecture docs.
Full plan (gap analysis, decisions, 4-repo map, waves): `docs/plano-execucao-fase-3.md`.
Notion import manifest: `docs/user-stories/f3-notion-import.md`.

| # | Story | SP | Wave | Repo |
|---|---|---|---|---|
| US-F3-DOC-01 | RFCs (cloud, DB, auth) | 3 | 0 | app/docs |
| US-F3-DOC-02 | ADRs (comm pattern, HPA, ...) | 2 | 0 | app/docs |
| US-F3-01 | Serverless CPF Authentication (Lambda) | 8 | 1 | lambda |
| US-F3-02 | API Gateway + route protection | 5 | 1 | lambda/infra-k8s |
| US-F3-03 | App as Resource Server (validate-only) | 5 | 1 | app |
| US-F3-04 | Terraform: Managed Database (RDS) | 5 | 2 | infra-db |
| US-F3-05 | Terraform: Kubernetes Cluster (EKS) | 8 | 2 | infra-k8s |
| US-F3-06 | Application deploy on EKS | 5 | 3 | app |
| US-F3-07 | 4-repo split + branch protection | 5 | 3 | all |
| US-F3-08 | Per-repo CI/CD with auto deploy | 8 | 3 | all |
| US-F3-09 | Structured JSON logs + correlation | 3 | 4 | app |
| US-F3-10 | Observability: APM, infra metrics, uptime | 5 | 4 | app/infra-k8s |
| US-F3-11 | Dashboards & alerts | 5 | 4 | app |
| US-F3-DOC-03 | Component + sequence diagrams | 3 | 5 | app/docs |
| US-F3-DOC-04 | DB justification + relational model + ER | 3 | 5 | app/docs |
| US-F3-DOC-05 | Per-repo READMEs | 3 | 5 | all |
| US-F3-DOC-06 | Docs index + main README overhaul | 3 | 5 | app/docs |
| US-F3-DOC-07 | QA Plans (backfill + Fase 3) | 5 | 5 | app/docs |
| US-F3-12 | Delivery: video + PDF + soat-architecture | 2 | 6 | all |

**Phase 3 repos:** `soat-fiap-oficina-auth-lambda` (1), `soat-fiap-oficina-infra-k8s` (2),
`soat-fiap-oficina-infra-db` (3), `soat-fiap-oficina-os-service` (4, this repo — renamed from `soat-fiap-oficina-mecanica-app` in Fase 4 / US-F4-06; it is the OS Service and the docs hub).

### Fase 4 — Microservices, Saga & Full Automation (`f4-*`)

Split into 3 microservices (OS Service = this repo evolved, Billing with
Mercado Pago, Execução with DynamoDB), **direct HTTP between services with
callbacks** (RFC-0008, 2026-11-03 — replaced the SNS+SQS messaging of RFC-0006;
US-F4-02 cancelled, US-F4-18 added), orchestrated saga with compensations,
BDD with **Gherkin + Cucumber** (professor's requirement: one `.feature` per flow in
each service + end-to-end in the hub), SonarCloud, per-service CI/CD. Every
service story has the sections "APIs que expoe / APIs que consome / O que salva no
banco". Plan (market insights, 12 decisions revised on 2026-11-03, 7-repo map,
waves): `docs/plano-execucao-fase-4.md`. Transport contract:
`docs/contratos/http-interno.md`. Stories: `docs/user-stories/f4-*.md`. Notion
manifest: `docs/user-stories/f4-notion-import.md`.

**Phase 4 repos (5–7 created 2026-09-30; rename of this repo happens in US-F4-06):** `soat-fiap-oficina-os-service` (4, renamed from this repo),
`soat-fiap-oficina-billing-service` (5), `soat-fiap-oficina-execucao-service` (6),
`soat-fiap-oficina-kit` (7); repos 1–3 from Phase 3 evolve in place.

## Working with user stories

When starting a task, read the corresponding file in `docs/user-stories/` for full context.

Example:
- "Implement US-06" -> read `docs/user-stories/06-abertura-os.md` and follow the acceptance criteria
- "What's the next task?" -> check the current sprint in the table above

Each user story contains:
- **User story** in the format "As [actor], I want [action], so that [benefit]"
- **Acceptance criteria** as a checklist
- **DDD Domain** and **DDD Layer** indicating where to implement
- **Story Points** and **Priority**

## QA Plan (mandatory)

Every User Story must have a corresponding **QA_PLAN** document in `docs/qa-plans/`. The QA Plan documents how to test the story and ensures all acceptance criteria are validated.

- **Format:** `docs/qa-plans/QA_PLAN_US-XX.md`
- **When to create:** after implementing the story, use the `/qa-plan XX` skill
- **Required content:**
  - Summary of what is being tested
  - Prerequisites (environment, data, configurations)
  - Test scenarios with detailed steps for each acceptance criterion
  - Edge cases (invalid inputs, boundary values)
  - Traceability table (acceptance criterion -> test scenarios)
  - Validation checklist
- **Rule:** each acceptance criterion must have at least one corresponding test scenario

## Entity Relationship Diagram

The file `docs/schema.dbml` contains the full ER diagram in DBML format. It can be imported at [dbdiagram.io](https://dbdiagram.io) to visualize all table relationships. Use it as a reference when implementing new entities or modifying the Prisma schema.

## Expected project structure (after Sprint 1)

```
src/
├── main.ts
├── app.module.ts
├── prisma/
│   ├── prisma.module.ts
│   └── prisma.service.ts
├── cliente/
│   ├── cliente.module.ts
│   ├── domain/
│   │   ├── cliente.entity.ts
│   │   └── cliente.repository.ts      # interface
│   ├── application/
│   │   └── cliente.service.ts
│   └── infrastructure/
│       ├── cliente.controller.ts
│       ├── dto/
│       └── prisma-cliente.repository.ts
├── servico/
│   └── ...  (same structure)
└── produto/
    └── ...  (same structure)
```

## Conventions

- **Ubiquitous Language** — use domain terms: OrdemDeServico (not "ticket"), Produto (not "peca"), Cliente, Veiculo
- **Validations** — CPF/CNPJ and license plate must be validated in the domain (Value Objects)
- **OS Status** — use enum: RECEBIDA, EM_DIAGNOSTICO, AGUARDANDO_APROVACAO, EM_EXECUCAO, AGUARDANDO_PAGAMENTO, FINALIZADA, ENTREGUE, CANCELADA
- **APIs** — RESTful, documented with Swagger decorators
- **Database** — PostgreSQL, rationale: robust ACID transaction support, rich data types, maturity
- **Tests** — minimum 80% coverage on critical domains

## Available MCP Servers

- **Notion** — create/read/update tasks on the "Tech Challenge Board"
- **Miro** — read the Event Storming from board `uXjVGwyI88w=`

Database Notion ID: `33a48f0b-bca5-805d-ac88-ed5a914239b0`
Data Source ID: `33a48f0b-bca5-8071-a6bd-000bcbd098d7`
