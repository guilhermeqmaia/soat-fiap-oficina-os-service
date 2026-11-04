# ADRs — Architecture Decision Records

ADRs registram as **decisões arquiteturais permanentes** (formato Nygard:
Contexto → Decisão → Consequências). O processo de decisão com alternativas,
quando existiu, está na [RFC](../rfcs/README.md) correspondente — os
documentos se linkam, não se duplicam.

Template: [TEMPLATE.md](TEMPLATE.md)

| ADR | Título | Status | Data |
|---|---|---|---|
| [ADR-0001](ADR-0001-padrao-de-comunicacao.md) | Padrão de comunicação entre componentes | Aceita | 2026-08-24 |
| [ADR-0002](ADR-0002-hpa-autoescalonamento.md) | Autoescalonamento horizontal com HPA | Aceita | 2026-08-24 |
| [ADR-0003](ADR-0003-app-resource-server.md) | Aplicação como Resource Server (valida-apenas) | Aceita | 2026-08-24 |
| [ADR-0004](ADR-0004-plataforma-de-observabilidade.md) | Plataforma de observabilidade (Datadog) | Aceita | 2026-08-24 |
| [ADR-0005](ADR-0005-api-gateway.md) | API Gateway (AWS API Gateway HTTP API) | Aceita | 2026-08-24 |
| [ADR-0006](ADR-0006-segregacao-4-repositorios.md) | Segregação em 4 repositórios e branches/deploy | Aceita | 2026-08-24 |
| [ADR-0007](ADR-0007-conta-aws-propria-oidc.md) | Conta AWS própria com OIDC (Academy como fallback) | Aceita | 2026-09-12 |
| [ADR-0008](ADR-0008-ambiente-efemero.md) | Ambiente efêmero — subir, pausar e derrubar por script | Aceita | 2026-09-12 |
| [ADR-0009](ADR-0009-outbox-e-consumidor-idempotente.md) | Transactional Outbox e consumidor idempotente | Substituída pela RFC-0008 | 2026-09-30 |
| [ADR-0010](ADR-0010-kit-compartilhado.md) | Kit compartilhado `@guilhermeqmaia/oficina-kit` | Aceita | 2026-09-30 |
| [ADR-0011](ADR-0011-qualidade-sonarcloud.md) | Validação de qualidade no CI com SonarCloud | Aceita | 2026-09-30 |
| [ADR-0012](ADR-0012-pagamento-mercado-pago.md) | Pagamento com Mercado Pago (Checkout Pro via API de Orders + webhook) | Aceita | 2026-09-30 (rev. 2026-11-03) |
| [ADR-0013](ADR-0013-api-gateway-multi-servico.md) | API Gateway multi-serviço | Aceita | 2026-09-30 (rev. 2026-11-03) |
| [ADR-0014](ADR-0014-instancia-rds-por-servico-e-endpoint-dynamodb.md) | Uma instância RDS por serviço e VPC Endpoint para o DynamoDB | Aceita | 2026-11-04 |

## Ciclo de vida

Uma ADR aceita não é editada em substância: mudanças de decisão geram uma
nova ADR com status `Substituída por ADR-XXXX` na antiga. Numeração
sequencial `ADR-0001, 0002, ...`.
