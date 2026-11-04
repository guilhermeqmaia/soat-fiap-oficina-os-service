# ADR-0009: Transactional Outbox e consumidor idempotente

**Status:** Substituída pela [RFC-0008](../rfcs/RFC-0008-comunicacao-http-entre-servicos.md) (03/11/2026)
**Data:** 2026-09-30

> **Nota (03/11/2026):** com a troca da mensageria por HTTP direto
> ([RFC-0008](../rfcs/RFC-0008-comunicacao-http-entre-servicos.md)) o outbox
> transacional, o poller e os consumidores SQS deixam de existir. O que sobrevive
> desta ADR: o **envelope** (`id`, `type`, `version`, `occurredAt`, `producer`,
> `data`) como corpo dos callbacks HTTP e a **idempotência** — por `id` do envelope
> nos callbacks (`processed_messages` no OS Service) e por `numeroOS` nos comandos.
> A DLQ é substituída por retry/backoff + alerta de saga parada + `reprocessar`
> (runbook [`saga-reprocessar.md`](../../runbooks/saga-reprocessar.md)). Contrato:
> [`docs/contratos/http-interno.md`](../../contratos/http-interno.md). O conteúdo
> abaixo é histórico.

## Contexto

Com três serviços e três bancos, "gravar no banco e publicar no broker" deixa de
ser atômico: um crash entre o commit e o `publish` perde o evento; um retry do
broker entrega a mesma mensagem duas vezes. As quatro empresas pesquisadas
convergem no mesmo trio — Nubank: "any message on Kafka has to be idempotent";
Uber: "we process orders after we persist them" e tabela LATE gravada na mesma
transação; iFood: DLQ + replay para não perder eventos.

## Decisão

- **Outbox transacional em todo produtor.** O evento é gravado na tabela/partição
  `outbox` **na mesma transação** da mudança de estado. Um *poller* (Postgres)
  ou o **DynamoDB Streams** (Execução) publica no SNS e marca como enviado.
  Nunca se chama o SDK do SNS de dentro de um caso de uso.
- **Consumidor idempotente em todo consumidor.** Antes de processar, o consumidor
  grava `messageId` em `processed_messages` (unique) na mesma transação do efeito;
  duplicata → `ack` silencioso com log `duplicate=true`. TTL de 7 dias.
- **Envelope padrão** (JSON, validado por schema do kit):
  `id` (UUID v7), `type` (`<dominio>.<fato>`), `version` (int), `occurredAt`,
  `correlationId` (número da OS), `causationId` (id da mensagem que originou),
  `producer` (serviço), `traceparent`, `data`.
  `type`, `correlationId` e `traceparent` também vão em *message attributes* para
  filtro de assinatura e continuidade do trace.
- **DLQ com triagem humana.** Após 5 tentativas a mensagem vai para a DLQ; alarme
  dispara; runbook descreve como inspecionar e **reprocessar** (nunca purgar sem
  análise — lição do *mortician* do Nubank).

## Consequências

- Complementa a [ADR-0001](ADR-0001-padrao-de-comunicacao.md): os eventos `@OnEvent`
  in-process viram registros de outbox; o `EventEmitter` continua existindo só para
  efeitos locais (métricas, auditoria).
- Toda tabela de domínio ganha vizinhança de `outbox` e `processed_messages`
  (Prisma) ou itens `MSG#` (DynamoDB) — fornecidos pelo kit ([ADR-0010](ADR-0010-kit-compartilhado.md)).
- Entrega **at-least-once** assumida em todo o sistema; efeitos externos
  (Mercado Pago, e-mail) também precisam de chave de idempotência.
- Consultas de "o que aconteceu com a OS X" podem ser respondidas pelo outbox do
  OS Service, além do `saga_os`.
