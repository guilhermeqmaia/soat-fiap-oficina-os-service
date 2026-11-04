# User Stories — Índice

Histórias de usuário do projeto, organizadas por fase. A coluna **Status**
reflete o campo `**Status:**` de cada arquivo. Planejamento por sprint/onda:
[`CLAUDE.md`](../../CLAUDE.md), [`plano-execucao-fase-2.md`](../plano-execucao-fase-2.md)
e [`plano-execucao-fase-3.md`](../plano-execucao-fase-3.md).

## Fase 1 — MVP (US-00 a US-23)

| # | História | Status |
|---|---|---|
| US-00 | [Setup Prisma + PostgreSQL](00-setup-prisma-postgres.md) | To Do |
| US-01 | [Cadastro de Cliente](01-cadastro-cliente.md) | To Do |
| US-02 | [CRUD Completo de Cliente](02-crud-cliente.md) | To Do |
| US-03 | [Cadastro de Veiculo](03-cadastro-veiculo.md) | To Do |
| US-04 | [Catalogo de Servicos](04-catalogo-servicos.md) | To Do |
| US-05 | [Catalogo de Produtos (Pecas e Insumos)](05-catalogo-produtos.md) | To Do |
| US-06 | [Abertura de Ordem de Servico](06-abertura-os.md) | To Do |
| US-07 | [Atribuir Mecanico Responsavel a OS](07-atribuir-mecanico.md) | To Do |
| US-08 | [Adicionar Diagnostico a OS](08-diagnostico.md) | To Do |
| US-09 | [Adicionar Servicos a OS](09-adicionar-servicos-os.md) | To Do |
| US-10 | [Adicionar Produtos/Pecas a OS](10-adicionar-produtos-os.md) | To Do |
| US-11 | [Calculo Automatico do Orcamento](11-orcamento-automatico.md) | To Do |
| US-12 | [Concluir Orcamento e Enviar para Aprovacao](12-envio-orcamento-aprovacao.md) | To Do |
| US-13 | [Aprovacao/Rejeicao do Orcamento pelo Cliente](13-aprovacao-orcamento.md) | To Do |
| US-14 | [Execucao dos Servicos](14-execucao-servico.md) | To Do |
| US-15 | [Finalizacao e Entrega do Veiculo](15-finalizacao-entrega.md) | To Do |
| US-16 | [Acompanhamento da OS pelo Cliente](16-acompanhamento-os.md) | To Do |
| US-17 | [Listagem e Detalhamento de OS (Gestao)](17-listagem-os.md) | To Do |
| US-18 | [Controle de Estoque (Entrada, Reserva e Baixa)](18-controle-estoque.md) | To Do |
| US-19 | [Autenticacao JWT](19-autenticacao-jwt.md) | To Do |
| US-20 | [Notificacao ao Cliente](20-notificacao-cliente.md) | To Do |
| US-21 | [Docker e Infraestrutura](21-docker-infraestrutura.md) | To Do |
| US-22 | [Testes Automatizados e Cobertura](22-testes-cobertura.md) | To Do |
| US-23 | [Documentacao Swagger das APIs](23-swagger-documentacao.md) | To Do |

## Fase 2 — Qualidade, Resiliência e Escalabilidade (`f2-*`)

| # | História | Status |
|---|---|---|
| US-F2-01 | [Listagem de OS com Ordenacao Customizada](f2-01-listagem-os-ordenacao.md) | To Do |
| US-F2-02 | [Webhook de Aprovacao de Orcamento (Notificacao Externa)](f2-02-webhook-aprovacao-orcamento.md) | To Do |
| US-F2-03 | [Adapter de Webhook para Notificacao de Mudanca de Status](f2-03-webhook-notificacao-status.md) | To Do |
| US-F2-04 | [Revisao da Containerizacao (Dockerfile + docker-compose)](f2-04-revisao-containerizacao.md) | To Do |
| US-F2-05 | [Manifestos Kubernetes para Deploy da Aplicacao](f2-05-manifestos-kubernetes.md) | In Review |
| US-F2-06 | [Infraestrutura como Codigo com Terraform (Cluster + Banco)](f2-06-terraform-iac.md) | In Review |
| US-F2-07 | [Pipeline CI/CD com Verificacao de Deploy](f2-07-cicd-completo.md) | In Review |
| US-F2-08 | [Desenho de Arquitetura e Atualizacao do README](f2-08-arquitetura-readme.md) | To Do |
| US-F2-09 | [Entrega Final — Video Demonstrativo e PDF](f2-09-entrega-video-pdf.md) | To Do |
| US-F2-10 | [Refatoracao para Clean Architecture (Use Cases + Gateways + Presenters)](f2-10-refatoracao-clean-architecture.md) | To Do |
| US-F2-11 | [Testes de Carga, Estresse, Pico, Soak e Escalabilidade (Performance)](f2-11-testes-carga-escalabilidade.md) | Concluída |

## Fase 3 — Nuvem, Segurança e Observabilidade (`f3-*`)

| # | História | Status |
|---|---|---|
| US-F3-01 | [Function Serverless de Autenticacao por CPF](f3-01-serverless-cpf-auth.md) | To Do |
| US-F3-02 | [API Gateway e Protecao de Rotas Sensiveis](f3-02-api-gateway.md) | To Do |
| US-F3-03 | [Aplicacao como Resource Server (validacao de JWT)](f3-03-app-resource-server.md) | To Do |
| US-F3-04 | [Terraform — Banco de Dados Gerenciado (RDS)](f3-04-terraform-banco-gerenciado.md) | To Do |
| US-F3-05 | [Terraform — Cluster Kubernetes Gerenciado (EKS)](f3-05-terraform-cluster-kubernetes.md) | To Do |
| US-F3-06 | [Deploy da Aplicacao no EKS](f3-06-deploy-aplicacao-eks.md) | To Do |
| US-F3-07 | [Segregacao em 4 Repositorios + Branch Protection](f3-07-segregacao-repositorios.md) | To Do |
| US-F3-08 | [CI/CD por Repositorio com Deploy Automatico](f3-08-cicd-multi-repo.md) | To Do |
| US-F3-09 | [Logs Estruturados (JSON) com Correlacao de Requisicoes](f3-09-logs-estruturados-correlacao.md) | To Do |
| US-F3-10 | [Observabilidade — APM, Metricas de Infra e Uptime](f3-10-observabilidade-apm.md) | To Do |
| US-F3-11 | [Dashboards e Alertas](f3-11-dashboards-alertas.md) | To Do |
| US-F3-12 | [Entrega — Video, PDF e Compartilhamento](f3-12-entrega-video-pdf.md) | To Do |
| US-F3-DOC-01 | [RFCs (Request for Comments)](f3-doc-01-rfcs.md) | Concluída |
| US-F3-DOC-02 | [ADRs (Architecture Decision Records)](f3-doc-02-adrs.md) | Concluída |
| US-F3-DOC-03 | [Diagrama de Componentes + Diagramas de Sequencia (Fase 3)](f3-doc-03-arquitetura-diagramas.md) | Concluída |
| US-F3-DOC-04 | [Justificativa do Banco + Modelo Relacional + ER](f3-doc-04-justificativa-banco-er.md) | Concluída |
| US-F3-DOC-05 | [READMEs por Repositorio](f3-doc-05-readmes-por-repo.md) | To Do |
| US-F3-DOC-06 | [Indice de Documentacao + Revisao do README Principal](f3-doc-06-indice-docs-readme.md) | In Progress |
| US-F3-DOC-07 | [QA Plans (backfill + Fase 3)](f3-doc-07-qa-plans-backfill.md) | To Do |

## Apoio

- [Manifesto de importação das histórias da Fase 3 para o Notion](f3-notion-import.md)

## Fase 4 — Microsserviços, Saga e Automação (`f4-*`)

Plano: [`docs/plano-execucao-fase-4.md`](../plano-execucao-fase-4.md) · Manifesto Notion: [f4-notion-import.md](f4-notion-import.md)

| # | História | Status |
|---|---|---|
| US-F4-DOC-01 | [RFCs — Decomposicao, Saga, Mensageria e NoSQL](f4-doc-01-rfcs.md) | Concluída |
| US-F4-DOC-02 | [ADRs — Outbox, Kit Compartilhado, SonarCloud, Mercado Pago e Gateway Multi-servico](f4-doc-02-adrs.md) | Concluída |
| US-F4-DOC-03 | [Contratos de Eventos e Comandos (AsyncAPI)](f4-doc-03-contratos-eventos.md) | Em revisão |
| US-F4-01 | [Kit Compartilhado dos Servicos (`@guilhermeqmaia/oficina-kit`)](f4-01-kit-compartilhado.md) | Concluída |
| ~~US-F4-02~~ | [Mensageria — SNS + SQS FIFO com DLQ (Terraform)](f4-02-mensageria.md) | Cancelada (03/11) — substituída pela US-F4-18 |
| US-F4-03 | [Bancos por Servico — Postgres (OS, Billing) e DynamoDB (Execucao)](f4-03-bancos-por-servico.md) | Em revisão |
| US-F4-04 | [Repositorios dos Servicos com CI/CD Independente (Build, Testes, Sonar, Deploy EKS)](f4-04-repos-e-cicd-por-servico.md) | Em revisão |
| US-F4-05 | [API Gateway Multi-servico e Webhook Publico do Mercado Pago](f4-05-gateway-multi-servico.md) | Em revisão |
| US-F4-18 | [Comunicacao HTTP entre Servicos (kit, OS Service, Billing, Execucao, infra)](f4-18-comunicacao-http-entre-servicos.md) | To Do (nova em 03/11) |
| US-F4-06 | [OS Service — Evolucao do Monolito (Strangler) e Publicacao de Eventos](f4-06-os-service-strangler.md) | Em revisão (transporte HTTP na US-F4-18) |
| US-F4-07 | [Execucao Service — Fila de Execucao, Diagnostico, Catalogo e Estoque em DynamoDB](f4-07-execucao-service.md) | To Do |
| US-F4-08 | [Billing Service — Orcamento, Aprovacao e Rejeicao](f4-08-billing-orcamento.md) | To Do |
| US-F4-12 | [Notificacoes ao Cliente a partir dos Eventos](f4-12-notificacoes-por-eventos.md) | To Do |
| US-F4-09 | [Billing Service — Pagamento com Mercado Pago (Checkout + Webhook)](f4-09-billing-mercado-pago.md) | To Do |
| US-F4-10 | [Saga Orquestrada da Ordem de Servico](f4-10-saga-orquestrada.md) | Em revisão |
| US-F4-11 | [Compensacoes e Rollback Seguro da Saga](f4-11-compensacoes-rollback.md) | Em revisão |
| US-F4-13 | [Testes Unitarios >= 80% por Servico e Quality Gate no CI](f4-13-cobertura-e-sonar.md) | To Do |
| US-F4-14 | [BDD dos Fluxos da OS (Gherkin + Cucumber) — exigencia do professor](f4-14-bdd-fluxo-completo.md) | Em andamento |
| US-F4-15 | [Testes de Contrato das APIs HTTP (OpenAPI por servico)](f4-15-testes-de-contrato.md) | To Do (reescrita em 03/11) |
| US-F4-16 | [Observabilidade Distribuida — Traces atraves das Chamadas HTTP, Dashboards por Servico e Alerta de Saga Parada](f4-16-observabilidade-distribuida.md) | To Do (reescrita em 03/11) |
| US-F4-DOC-04 | [Diagrama Geral da Arquitetura e Sequencias da Saga](f4-doc-04-diagramas.md) | To Do |
| US-F4-DOC-05 | [READMEs por Servico com Evidencias de Cobertura e Swagger](f4-doc-05-readmes-por-servico.md) | To Do |
| US-F4-DOC-06 | [QA Plans da Fase 4](f4-doc-06-qa-plans.md) | To Do |
| US-F4-17 | [Entrega da Fase 4 — Video, PDF e Diagrama Geral](f4-17-entrega-video-pdf.md) | To Do |
