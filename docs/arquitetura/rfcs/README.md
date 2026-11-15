# RFCs — Request for Comments

RFCs registram o **processo de decisão** (contexto, alternativas, trade-offs)
das escolhas técnicas relevantes da Fase 3. A decisão permanente resultante
vira um [ADR](../adr/README.md) — os documentos se linkam, não se duplicam.

Template: [TEMPLATE.md](TEMPLATE.md)

| RFC | Título | Status | Data |
|---|---|---|---|
| [RFC-0001](RFC-0001-escolha-da-nuvem.md) | Escolha da nuvem (AWS × GCP × Azure × local) | Aceita | 2026-08-24 |
| [RFC-0002](RFC-0002-escolha-do-banco.md) | Escolha do banco gerenciado (RDS PostgreSQL) | Aceita | 2026-08-24 |
| [RFC-0003](RFC-0003-estrategia-de-autenticacao.md) | Estratégia de autenticação (CPF serverless, staff, JWT) | Aceita | 2026-08-24 |
| [RFC-0004](RFC-0004-decomposicao-em-microsservicos.md) | Decomposição em microsserviços (3 × 5 × alternativa) | Aceita | 2026-09-30 |
| [RFC-0005](RFC-0005-estrategia-de-saga.md) | Estratégia de Saga — orquestração vs coreografia | Aceita | 2026-09-30 |
| [RFC-0006](RFC-0006-mensageria.md) | Mensageria assíncrona (SNS+SQS × RabbitMQ × Kafka × EventBridge) | Substituída pela RFC-0008 | 2026-09-30 |
| [RFC-0007](RFC-0007-banco-nosql.md) | Banco NoSQL para o Execução Service (DynamoDB) | Aceita (revisada em 2026-11-09: uma tabela por agregado) | 2026-09-30 |
| [RFC-0008](RFC-0008-comunicacao-http-entre-servicos.md) | Comunicação HTTP entre os serviços (substitui a mensageria) | Aceita | 2026-11-03 |

## Ciclo de vida

`Proposta` → discussão em PR → `Aceita` (ou recusada) → eventualmente
`Substituída por RFC-XXXX`. RFCs aceitas não são editadas em substância —
mudanças de rumo geram uma nova RFC que substitui a anterior.
