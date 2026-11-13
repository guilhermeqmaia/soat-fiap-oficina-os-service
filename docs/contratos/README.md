# Contratos entre os serviços (Fase 4)

Dois arquivos, dois papéis (decisão de 03/11/2026 — [RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md)):

| Arquivo | Papel |
|---|---|
| [`http-interno.md`](http-interno.md) | **Transporte — contrato efetivo.** Cada comando do orquestrador é um endpoint HTTP no participante; cada evento é a resposta síncrona desse endpoint ou um callback `POST /ordens-servico/{numero}/eventos` no OS Service. Define princípios (retry/backoff, idempotência, JWT `SERVICO`, correlação), endpoints, códigos de resposta, envelope e o fluxo. **Leia inteiro antes de implementar.** |
| [`asyncapi.yaml`](asyncapi.yaml) | **Vocabulário e payloads.** Nomes dos `type`s (`execucao.*`, `billing.*`), schemas JSON de `data` e envelope. Os canais/filas descritos nele são históricos (SNS/SQS, RFC-0006 substituída); os schemas continuam sendo a fonte dos `data` dos callbacks e das respostas. |
| [`openapi/`](openapi/README.md) | **OpenAPI de cada serviço** (OS, Billing, Execução), exportado do Swagger e versionado aqui — fonte dos testes de contrato ([US-F4-15](../user-stories/f4-15-testes-de-contrato.md)). |
| [`schemas/`](schemas/) | **JSON Schemas validáveis** do envelope, do `data` de cada `type`, dos corpos dos comandos e da tabela comando → endpoint/respostas (`endpoints-participantes.json`). Espelham `http-interno.md` + `asyncapi.yaml`; o OpenAPI do OS Service e os testes de contrato leem daqui ([US-F4-15](../user-stories/f4-15-testes-de-contrato.md)). |
| [`exemplos/`](exemplos/README.md) | Payloads reais (webhook do Mercado Pago). |

## Mapeamento evento → endpoint/callback (vigente)

| Vocabulário | Como trafega |
|---|---|
| `execucao.enfileirar` → `execucao.enfileirada` / `execucao.recusada` | `POST /execucao/ordens` → `201` / `409` |
| `execucao.iniciar` → `execucao.iniciada` / `execucao.recusada` | `POST /execucao/ordens/{n}/iniciar` → `200` / `409` |
| `execucao.liberar-reservas` → `execucao.reservas-liberadas` | `DELETE /execucao/ordens/{n}` → `200` |
| `execucao.diagnostico-concluido`, `execucao.finalizada` | callback `POST /ordens-servico/{n}/eventos` (Execução → OS) |
| `billing.gerar-orcamento` → `billing.orcamento-gerado` | `POST /orcamentos` → `201`/`200` |
| `billing.cobrar` → `billing.cobranca-criada` | `POST /orcamentos/{n}/cobrar` → `201` |
| `billing.cancelar-orcamento` → `billing.orcamento-cancelado` | `DELETE /orcamentos/{n}` → `200` |
| `billing.orcamento-aprovado`, `billing.orcamento-rejeitado`, `billing.pagamento-aprovado`, `billing.pagamento-recusado` | callback `POST /ordens-servico/{n}/eventos` (Billing → OS) |
| `os.aberta`, `os.cancelada`, `os.finalizada`, `os.entregue` | **não são mais publicados** — Notificação in-process no OS Service |

## Tabela histórica (SNS/SQS, até 03/11/2026)

| Mensagem | Tipo | Produtor | Consumidores (fila) | DLQ |
|---|---|---|---|---|
| `os.aberta` | evento | OS Service | Notificação (`notificacao-eventos`) | `notificacao-eventos-dlq` |
| `os.cancelada` / `os.finalizada` / `os.entregue` | evento | OS Service | Notificação | idem |
| `execucao.enfileirar` / `execucao.iniciar` / `execucao.liberar-reservas` | **comando** | OS Service (orquestrador) | Execução (`execucao-comandos`) | `execucao-comandos-dlq` |
| `execucao.enfileirada` / `execucao.recusada` / `execucao.diagnostico-concluido` / `execucao.iniciada` / `execucao.finalizada` / `execucao.reservas-liberadas` | evento | Execução | OS Service (`os-eventos`) | `os-eventos-dlq` |
| `billing.gerar-orcamento` / `billing.cobrar` / `billing.cancelar-orcamento` | **comando** | OS Service (orquestrador) | Billing (`billing-comandos`) | `billing-comandos-dlq` |
| `billing.orcamento-gerado` / `billing.orcamento-aprovado` / `billing.orcamento-rejeitado` / `billing.cobranca-criada` / `billing.pagamento-aprovado` / `billing.pagamento-recusado` / `billing.orcamento-cancelado` | evento | Billing | OS Service (`os-eventos`); Notificação (`notificacao-eventos`) para gerado/aprovado/cobranca-criada (link de pagamento)/pagamento-* | idem |

Momento da cobrança (decisão de 03/11/2026, ADR-0012): `billing.orcamento-aprovado` **não** cria cobrança — a order do Mercado Pago só é criada quando o orquestrador envia `billing.cobrar` (após `execucao.finalizada`), e o link chega em `billing.cobranca-criada`.

Decisões: [RFC-0005 (saga)](../arquitetura/rfcs/RFC-0005-estrategia-de-saga.md) · [RFC-0008 (HTTP entre serviços — vigente)](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md) · históricas: [RFC-0006 (mensageria)](../arquitetura/rfcs/RFC-0006-mensageria.md), [ADR-0009 (outbox, idempotência)](../arquitetura/adr/ADR-0009-outbox-e-consumidor-idempotente.md).

Validar/renderizar: `npx -y @asyncapi/cli validate docs/contratos/asyncapi.yaml` · `npx -y @asyncapi/cli generate fromTemplate docs/contratos/asyncapi.yaml @asyncapi/html-template -o docs/contratos/html`.
