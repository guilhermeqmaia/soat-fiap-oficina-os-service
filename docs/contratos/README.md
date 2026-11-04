# Contratos de mensagens (Fase 4)

- [`asyncapi.yaml`](asyncapi.yaml) — catálogo AsyncAPI 3 de **todos** os eventos e comandos trocados via SNS/SQS: canais (tópicos/filas), operações por serviço, envelope comum e schemas JSON.

## Tabela evento → produtor → consumidores → fila → DLQ

| Mensagem | Tipo | Produtor | Consumidores (fila) | DLQ |
|---|---|---|---|---|
| `os.aberta` | evento | OS Service | Notificação (`notificacao-eventos`) | `notificacao-eventos-dlq` |
| `os.cancelada` / `os.finalizada` / `os.entregue` | evento | OS Service | Notificação | idem |
| `execucao.enfileirar` / `execucao.iniciar` / `execucao.liberar-reservas` | **comando** | OS Service (orquestrador) | Execução (`execucao-comandos`) | `execucao-comandos-dlq` |
| `execucao.enfileirada` / `execucao.recusada` / `execucao.diagnostico-concluido` / `execucao.iniciada` / `execucao.finalizada` / `execucao.reservas-liberadas` | evento | Execução | OS Service (`os-eventos`) | `os-eventos-dlq` |
| `billing.gerar-orcamento` / `billing.cobrar` / `billing.cancelar-orcamento` | **comando** | OS Service (orquestrador) | Billing (`billing-comandos`) | `billing-comandos-dlq` |
| `billing.orcamento-gerado` / `billing.orcamento-aprovado` / `billing.orcamento-rejeitado` / `billing.cobranca-criada` / `billing.pagamento-aprovado` / `billing.pagamento-recusado` / `billing.orcamento-cancelado` | evento | Billing | OS Service (`os-eventos`); Notificação (`notificacao-eventos`) para gerado/aprovado/cobranca-criada (link de pagamento)/pagamento-* | idem |

Momento da cobrança (decisão de 03/11/2026, ADR-0012): `billing.orcamento-aprovado` **não** cria cobrança — a order do Mercado Pago só é criada quando o orquestrador envia `billing.cobrar` (após `execucao.finalizada`), e o link chega em `billing.cobranca-criada`.

Decisões: [RFC-0005 (saga)](../arquitetura/rfcs/RFC-0005-estrategia-de-saga.md) · [RFC-0006 (mensageria)](../arquitetura/rfcs/RFC-0006-mensageria.md) · [ADR-0009 (envelope, outbox, idempotência)](../arquitetura/adr/ADR-0009-outbox-e-consumidor-idempotente.md).

Validar/renderizar: `npx -y @asyncapi/cli validate docs/contratos/asyncapi.yaml` · `npx -y @asyncapi/cli generate fromTemplate docs/contratos/asyncapi.yaml @asyncapi/html-template -o docs/contratos/html`.
