# RFC-0006: Mensageria assíncrona

**Status:** Substituída pela [RFC-0008](RFC-0008-comunicacao-http-entre-servicos.md) (03/11/2026)
**Data:** 2026-09-30
**Autores:** Time SOAT
**Stories relacionadas:** [US-F4-02](../../user-stories/f4-02-mensageria.md), [US-F4-01](../../user-stories/f4-01-kit-compartilhado.md), [US-F4-16](../../user-stories/f4-16-observabilidade-distribuida.md)

> **Nota (03/11/2026):** em 03/11 o time decidiu trocar a mensageria SNS/SQS por
> **comunicação HTTP direta entre os serviços** (chamadas síncronas com retry +
> callbacks HTTP para o OS Service). O racional, as opções e os princípios estão na
> [RFC-0008](RFC-0008-comunicacao-http-entre-servicos.md); o contrato efetivo é
> [`docs/contratos/http-interno.md`](../../contratos/http-interno.md). A US-F4-02
> foi cancelada e o stage `messaging/` do infra-k8s será removido na US-F4-18.
> O conteúdo abaixo é mantido como histórico da decisão original.

## Contexto

O enunciado exige "mensageria assíncrona (RabbitMQ, Kafka, SQS, etc.) para
eventos e integração desacoplada". Regras do projeto: sempre serviços AWS
([RFC-0001](RFC-0001-escolha-da-nuvem.md)), tudo dentro da VPC, Terraform,
custo controlado na conta própria (orçamento US$ 20/mês), e ambiente local
completo para BDD. Volume esperado: dezenas de mensagens por OS, centenas por
dia na demo.

Insights: iFood (Connection) usa **SNS para propagar** eventos validados e
**SQS para ingestão** com workers; Nubank e Uber usam Kafka como log imutável —
mas operam milhares de serviços e bilhões de eventos/dia. O Confluent relata
que, mesmo gerenciado (MSK), o iFood gastava a maior parte do tempo com
dimensionamento e patches do Kafka.

## Opções consideradas

### Opção A — Amazon SNS + SQS (FIFO) com DLQ

- ✅ Serverless, sem cluster; **free tier** (1 M requisições SQS/mês) cobre a fase inteira
- ✅ DLQ nativa por fila; retry por *visibility timeout*; filtro de assinatura por atributo (`type`)
- ✅ **FIFO com `MessageGroupId` = número da OS** garante ordem por saga e deduplicação de 5 min
- ✅ Terraform trivial; **LocalStack** reproduz SNS/SQS localmente
- ✅ Citado no enunciado
- ❌ Sem replay nativo de histórico (mitigado: outbox guarda tudo; DLQ + reprocessamento)
- ❌ Fan-out por assinatura SNS→SQS exige uma fila por consumidor (é a topologia desejada)

### Opção B — Amazon MQ (RabbitMQ)

- ✅ Semântica AMQP familiar; exchanges/routing keys
- ❌ ~US$ 20–25/mês para a menor instância **parada** (mq.t3.micro), fora do orçamento
- ❌ Broker stateful para operar (patches, storage); sem vantagem para o volume

### Opção C — Amazon MSK (Kafka)

- ✅ Log imutável com replay; padrão de Nubank/Uber/iFood em escala
- ❌ ~US$ 150+/mês mínimo (3 brokers) ou MSK Serverless ~US$ 0,75/h por cluster; inviável no orçamento
- ❌ Complexidade operacional que o próprio iFood relatou como problema

### Opção D — Amazon EventBridge

- ✅ Roteamento por regras, archive/replay (caso iFood middleware)
- ❌ Sem FIFO/ordenação; entrega para SQS de qualquer forma; latência maior; menos aderente a comandos ponto-a-ponto da saga orquestrada

## Decisão

**Opção A — SNS + SQS FIFO com DLQ**, provisionados por Terraform no
`soat-fiap-oficina-infra-k8s` (stage `messaging/`).

- Tópicos SNS FIFO por domínio produtor: `oficina-os`, `oficina-billing`, `oficina-execucao`
- Filas SQS FIFO por consumidor (ex.: `execucao-comandos`, `billing-comandos`, `os-eventos`, `notificacao-eventos`), assinaturas com **filtro por `type`**
- DLQ por fila, `maxReceiveCount = 5`, alarme quando `ApproximateNumberOfMessagesVisible > 0`
- `MessageGroupId` = número da OS; `MessageDeduplicationId` = id do evento (outbox)

## Consequências

- Envelope padrão e propagação de `traceparent`/`correlationId` em *message attributes* ficam no kit ([ADR-0009](../adr/ADR-0009-outbox-e-consumidor-idempotente.md)).
- Cada serviço só publica no próprio tópico e só consome as próprias filas (IAM).
- Compose local com LocalStack replica a mesma topologia (`scripts/messaging-local.sh`).
- Migrar para Kafka no futuro exige apenas trocar o adaptador do kit — os contratos (AsyncAPI) não mudam.
