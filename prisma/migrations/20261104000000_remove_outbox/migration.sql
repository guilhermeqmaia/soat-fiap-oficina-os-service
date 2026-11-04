-- US-F4-18: comunicacao HTTP direta entre os servicos (RFC-0008) — o outbox transacional
-- (SNS/SQS, ADR-0009) deixa de existir. `processed_messages` fica para deduplicar callbacks.
DROP TABLE IF EXISTS "outbox";
