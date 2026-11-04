# Documentação — Oficina Mecânica (Tech Challenge FIAP)

Hub central da documentação do repositório `soat-fiap-oficina-os-service`.
O [README principal](../README.md) é a porta de entrada com o essencial; os
documentos abaixo detalham cada tema.

## Arquitetura

| Documento | Descrição |
|---|---|
| [RFCs](arquitetura/rfcs/README.md) | Decisões técnicas com alternativas (nuvem, banco, autenticação, microsserviços, saga, HTTP entre serviços) |
| [ADRs](arquitetura/adr/README.md) | Decisões arquiteturais permanentes |
| [Arquitetura Fase 3](arquitetura/arquitetura-fase3.md) | Diagrama de componentes (visão de nuvem AWS), sequências de autenticação por CPF e abertura de OS, fluxo de deploy dos 4 repos e legenda RFCs/ADRs (US-F3-DOC-03) |
| [Arquitetura Fase 2](arquitetura/arquitetura-fase2.md) | Desenho da arquitetura da Fase 2 (Kubernetes, CI/CD, IaC) |
| [Clean Architecture](arquitetura/clean-architecture.md) | Refatoração para Use Cases + Gateways + Presenters |
| [Banco de dados](arquitetura/banco-de-dados.md) | Justificativa formal do PostgreSQL/RDS vs alternativas, diagrama ER, relacionamentos, ajustes da Fase 3, consistência e índices (US-F3-DOC-04) |
| [Modelo ER (`schema.dbml`)](schema.dbml) | Diagrama entidade-relacionamento em DBML (importe em [dbdiagram.io](https://dbdiagram.io)) |

## Event Storming (DDD)

- **Miro board (público):** <https://miro.com/app/board/uXjVGwyI88w=/?share_link_id=464407873082>
  — versão mais recente: *Event Storming v3 (30/03)*. Bounded contexts, atores e
  políticas estão resumidos em [`CLAUDE.md`](../CLAUDE.md).

## User Stories

- [Índice das histórias por fase](user-stories/README.md) — Fase 1 (US-00 a US-23), Fase 2 (`f2-*`), Fase 3 (`f3-*`) e Fase 4 (`f4-*`), com status.

## QA Plans

- [Índice dos QA Plans](qa-plans/README.md) — planos de teste manual/automatizado por User Story.

## Segurança

| Documento | Descrição |
|---|---|
| [Segurança](seguranca.md) | Práticas de segurança adotadas na aplicação |
| [Scans de vulnerabilidade](scans/) | Relatório ([`RELATORIO_VULNERABILIDADES.md`](scans/RELATORIO_VULNERABILIDADES.md)) e resultados brutos (npm audit, Semgrep, Trivy) em [`scans/raw/`](scans/raw/) |

## Curls (exemplos de uso da API)

| Documento | Módulo |
|---|---|
| [`curls-cliente.md`](curls-cliente.md) | Cliente |
| [`curls-veiculo.md`](curls-veiculo.md) | Veículo |
| [`curls-ordem-servico.md`](curls-ordem-servico.md) | Ordem de Serviço |
| [`curls-usuario.md`](curls-usuario.md) | Usuário / Autenticação |

## Notificações

- [Notificação por e-mail](notificacao-email.md) — configuração dos adapters Ethereal (teste) e Brevo (produção).

## Planos de Execução

| Documento | Descrição |
|---|---|
| [Plano de execução — Fase 2](plano-execucao-fase-2.md) | Qualidade, resiliência e escalabilidade |
| [Plano de execução — Fase 3](plano-execucao-fase-3.md) | Nuvem, segurança e observabilidade (gap analysis, mapa dos 4 repos, ondas) |

## Storytelling

- [`storytelling/`](storytelling/) — cenários narrados do fluxo da OS (abertura, diagnóstico, orçamento, execução e finalização) em formato `.egn`.

## Outros

| Documento | Descrição |
|---|---|
| [Testes iniciais de OS via Swagger](testes-iniciais-ordens-servico-via-swagger.md) | Roteiro manual de validação das Ordens de Serviço |
| [`tech-challenges/`](tech-challenges/) | Enunciados oficiais (PDF) das Fases 1, 2 e 3 |

## Entrega

- [entrega-fase-3.md](entrega-fase-3.md) — documento de entrega da Fase 3 (fonte do PDF): repositórios, evidências de proteção de branch, roteiro do vídeo, links da documentação e URLs de deploy

## Fase 4

- [plano-execucao-fase-4.md](plano-execucao-fase-4.md) — plano da Fase 4 (insights de mercado, decisões revisadas em 03/11, ondas, 23 histórias)
- [contratos/http-interno.md](contratos/http-interno.md) — **contrato efetivo** da comunicação HTTP entre os serviços (RFC-0008): endpoints, callbacks, envelope, retry/idempotência
- [contratos/](contratos/README.md) — AsyncAPI (vocabulário/payloads dos eventos), OpenAPI por serviço (`openapi/`) e exemplos
- [runbooks/saga-reprocessar.md](runbooks/saga-reprocessar.md) — saga parada / retry esgotado → reprocessar (sem DLQ)
- [mercado-pago-sandbox.md](mercado-pago-sandbox.md) — sandbox, orders de teste e webhook local do Mercado Pago
- [tech-challenges/fase-4-tech-challenge.pdf](tech-challenges/fase-4-tech-challenge.pdf) — enunciado

## Painel da Fase 4

[`dashboard-fase-4.html`](dashboard-fase-4.html) — progresso por onda, divisão proposta por pessoa e decisões, para abrir no navegador (arquivo único, sem dependências).
