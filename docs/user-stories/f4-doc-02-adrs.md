# US-F4-DOC-02: ADRs — Outbox, Kit Compartilhado, SonarCloud, Mercado Pago e Gateway Multi-servico

**User Story:** Como Arquiteto do time, quero registrar as decisoes permanentes de implementacao em ADRs, para que os tres servicos sigam as mesmas regras de consistencia, qualidade e integracao.

**Prioridade:** Alta
**Story Points:** 2
**Status:** Concluída
**DDD Domain:** Todos
**DDD Layer:** Documentacao (`docs/arquitetura/adr/`)
**Repositorio:** 4 — hub de documentacao

## Contexto

Alem das quatro RFCs, ha decisoes de *como* implementar que precisam ser
uniformes nos tres servicos. Uma ADR curta por decisao (formato Nygard).

## Criterios de Aceite

- [x] **ADR-0009 — Transactional Outbox + consumidor idempotente:** todo evento sai da mesma transacao que muda o estado; todo consumidor deduplica por `messageId`; envelope padrao (`id`, `type`, `occurredAt`, `correlationId` = numero da OS, `causationId`, `version`, `traceparent`)
- [x] **ADR-0010 — Kit compartilhado (`@guilhermeqmaia/oficina-kit`):** o que entra (auth resource server, logs, metricas, mensageria, outbox) e o que NAO entra (nada de dominio); versionamento semver via GitHub Packages
- [x] **ADR-0011 — Qualidade no CI com SonarCloud:** quality gate obrigatorio (cobertura >= 80%, 0 bugs/vulnerabilidades novas) como check de branch protection
- [x] **ADR-0012 — Pagamento com Mercado Pago:** Checkout Pro via API de Orders + webhook assinado; pagamento acontece na aprovacao do orcamento; sandbox para demo de falhas
- [x] **ADR-0013 — API Gateway multi-servico:** um HTTP API, rotas por prefixo para cada servico, um NLB interno com um listener por servico; rota publica do webhook do Mercado Pago validada por assinatura
- [x] **ADR-0001 marcada como "Complementada por ADR-0009"** (a Fase 3 previu o corte por eventos in-process)
- [x] `docs/arquitetura/adr/README.md` atualizado
## Dependencias

- [US-F4-DOC-01](f4-doc-01-rfcs.md)
