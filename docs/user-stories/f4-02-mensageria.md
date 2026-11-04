# US-F4-02: Mensageria — SNS + SQS FIFO com DLQ (Terraform)

**User Story:** Como Plataforma, quero topicos e filas provisionados por Terraform com DLQ e ordenacao por OS, para que os servicos se integrem de forma assincrona e desacoplada sem perder mensagens.

**Prioridade:** Alta
**Story Points:** 5
**Status:** Cancelada (03/11/2026) — substituída pela [US-F4-18](f4-18-comunicacao-http-entre-servicos.md). Historico: stage mergeado (infra-k8s PR #30), plan real 41 recursos; QA: [QA_PLAN_US-F4-02](../qa-plans/QA_PLAN_US-F4-02.md)
**DDD Domain:** Transversal
**DDD Layer:** Infrastructure (Terraform)
**Repositorio:** 2 — `soat-fiap-oficina-infra-k8s` (stage `messaging/`)

## Cancelamento (03/11/2026)

Em 03/11 o time decidiu trocar a mensageria SNS/SQS por **comunicacao HTTP direta
entre os servicos** (chamadas sincronas com retry + callbacks HTTP para o OS
Service) — [RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md),
contrato em [`docs/contratos/http-interno.md`](../contratos/http-interno.md). O stage
`messaging/` do infra-k8s, o LocalStack e as variaveis `SNS_TOPIC_ARN`/`SQS_QUEUE_URL`
sao **removidos na US-F4-18**. Os criterios abaixo ficam como historico do que foi
entregue (infra-k8s PR #30) e nao devem ser evoluidos.

## Contexto

Enunciado: "Mensageria assincrona (RabbitMQ, Kafka, SQS, etc.) para eventos e
integracao desacoplada". Decisao (RFC-0006): **SNS + SQS**, AWS-nativo,
serverless e barato; FIFO com `MessageGroupId` = numero da OS garante ordem por
saga; DLQ nativa por fila.

## Criterios de Aceite

- [x] Stage `messaging/` no infra-k8s: topicos SNS FIFO por dominio (`oficina-os`, `oficina-execucao`, `oficina-billing`) e filas SQS FIFO por consumidor (ex.: `execucao-de-os`, `billing-de-execucao`, `os-de-billing`, `os-de-execucao`, `notificacao`)
- [x] Assinaturas SNS -> SQS com **filtro por `type`** (message attributes) — um consumidor so recebe o que assina
- [x] **DLQ por fila** (`maxReceiveCount` 5) + alarme CloudWatch/Datadog quando DLQ > 0
- [x] Politica de acesso: cada servico so publica no proprio topico e so consome as proprias filas (IAM policy por service account ou por credencial no Secrets Manager — respeitando o modo da conta)
- [x] Outputs (ARNs/URLs) publicados em SSM (`/oficina/messaging/...`) + `scripts/messaging-vars.sh` para os deploys lerem
- [x] Compose de referencia com LocalStack (no kit, US-F4-01) reproduzindo a mesma topologia (script `scripts/messaging-local.sh`)
- [x] Custo mensal estimado documentado (free tier: 1M req SQS/mes)
## Dependencias

- [US-F4-DOC-01](f4-doc-01-rfcs.md) (RFC-0006)
