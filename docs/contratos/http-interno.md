# Comunicação HTTP entre os serviços (Fase 4, decisão de 03/11/2026)

Substitui a mensageria SNS/SQS (RFC-0006, ADR-0009). Decisão registrada na RFC-0008.
Os **nomes e payloads** dos comandos/eventos do `asyncapi.yaml` são mantidos como
vocabulário: cada comando vira um endpoint HTTP e cada evento vira (a) a resposta
síncrona desse endpoint, quando o resultado é imediato, ou (b) um **callback** HTTP
para o OS Service, quando depende de uma pessoa (mecânico, cliente) ou do Mercado Pago.

## Princípios

| Tema | Regra |
|---|---|
| Orquestração | O OS Service continua o orquestrador (RFC-0005). A máquina de estados `SagaOS` não muda; só o transporte. |
| Chamadas OS → serviço | HTTP síncrono, base interna pelo DNS do cluster (`http://execucao-service:3002`, `http://billing-service:3001`); em dev, `localhost`. Timeout 5 s, **3 tentativas com backoff exponencial** (200 ms, 800 ms, 3 s) só para `5xx`/timeout/erro de rede. `4xx` não repete. Esgotadas as tentativas, a saga fica no passo (histórico `chamada-falhou` com `tentativas`, conta em `oficina_os_sagas_paradas` no próximo ciclo do relógio da saga — `SAGA_TIMEOUTS_INTERVALO_MS`, sem esperar `SAGA_ALERTA_PARADA_MIN`) e o alerta de saga parada / `POST /admin/sagas/:numero/reprocessar` reenvia. |
| Callbacks serviço → OS | `POST /ordens-servico/{numero}/eventos` no OS Service, corpo = envelope (abaixo). Quem chama também aplica retry 3x. O OS responde `200` com o resultado da saga (`aplicado`, `passo`, `status`) ou `409` se a OS/saga estiver em conflito (releia e repita). |
| Idempotência | Comandos: chave = `numeroOS` (repetir a chamada não duplica efeito). Callbacks: chave = `id` do envelope (tabela `processed_messages` no OS; repetição devolve `200 { aplicado: false, duplicado: true }`). |
| Autenticação entre serviços | JWT com `role: SERVICO` e `sub` = nome do serviço (`os-service`, `billing-service`, `execucao-service`), assinado com o **mesmo `JWT_SECRET`** da Lambda; emitido localmente por cada serviço (`mintServiceToken` do kit), sem passar pela Lambda. Endpoints internos e callbacks aceitam só `SERVICO`; endpoints de usuário continuam com os roles de hoje. |
| Correlação | Cabeçalhos `x-correlation-id` (= número da OS) e `traceparent` propagados em toda chamada e callback (kit `logging`). Opcional no callback: `x-tentativa` (número da tentativa de quem chama; só vai para o log — o cliente do kit 0.3.0 ainda não envia). |
| Observabilidade (US-F4-16) | Quem chama mede `oficina_http_interno_total{origem,destino,rota,resultado=sucesso\|recusa\|esgotado\|erro}` e `oficina_http_interno_duracao_seconds{origem,destino,rota,status}` (`rota` = template, ex. `POST /orcamentos/{numero}/cobrar`). O OS mede `oficina_callbacks_total{type,resultado=aplicado\|duplicado\|ignorado\|conflito\|nao_encontrado\|erro}`. Logs com `trace_id`, `correlation_id`, `servico`, `rota`, `tentativa`. |
| Exposição | Os três serviços ficam atrás do API Gateway (prefixos `/ordens-servico|/clientes|/veiculos|/usuario|/notificacoes|/auth/me` → OS; `/orcamentos|/pagamentos|/webhooks` → Billing; `/execucao|/catalogo|/estoque` → Execução). Chamadas entre serviços **não passam** pelo gateway: vão direto pelo DNS interno. |
| Erros de negócio | `409 Conflict` com `{ motivo }` significa "recusado" (ex.: enfileirar recusado, iniciar fora de hora) e vira o evento de falha correspondente na saga. `404` = OS/recurso desconhecido no destino (erro de configuração, não repete). |

### Envelope (callbacks e corpo dos eventos)

```json
{
  "id": "uuid v7",
  "type": "execucao.diagnostico-concluido",
  "version": 1,
  "occurredAt": "2026-11-03T18:00:00Z",
  "producer": "execucao-service",
  "data": { "numeroOS": "OS-2026-0001", "...": "payload do asyncapi.yaml" }
}
```

`correlationId` deixa de existir no corpo: é o `{numero}` do path e o cabeçalho `x-correlation-id`.

**Schemas validáveis** (US-F4-15): [`schemas/`](schemas/) traz este envelope, o `data` de cada `type`, os corpos dos comandos e a tabela comando → endpoint/respostas ([`endpoints-participantes.json`](schemas/endpoints-participantes.json)) em JSON Schema; o OpenAPI do OS Service ([`openapi/os-service.yaml`](openapi/os-service.yaml)) é gerado deles. Mudou uma tabela deste documento? Mude o schema junto — os testes de contrato dos serviços leem de lá.

## OS Service → Execução Service

| Comando (vocabulário) | Endpoint na Execução | Corpo | Resposta imediata = evento | Falha de negócio |
|---|---|---|---|---|
| `execucao.enfileirar` | `POST /execucao/ordens` | `{ numeroOS, veiculoId, descricaoProblema }` | `201 { numeroOS, posicaoFila }` ≙ `execucao.enfileirada` | `409 { motivo }` ≙ `execucao.recusada` (veículo já em execução) |
| `execucao.iniciar` | `POST /execucao/ordens/{numeroOS}/iniciar` | — | `200 { numeroOS, status }` ≙ `execucao.iniciada` (só muda o status: as peças já foram baixadas no diagnóstico; idempotente) | `409 { motivo }` ≙ `execucao.recusada` (execução não está aguardando aprovação) |
| `execucao.liberar-reservas` | `DELETE /execucao/ordens/{numeroOS}` | `{ motivo }` | `200 { numeroOS, status, devolucoes[] }` ≙ `execucao.reservas-liberadas` (tira da fila, aborta o diagnóstico e devolve ao estoque as peças baixadas para a OS) | — (idempotente: repetir não devolve de novo; `200` mesmo sem execução ou sem peças baixadas). Deve aceitar também execução já `EM_EXECUCAO`, porque o OS ainda cancela no passo `INICIAR_EXECUCAO` |

**Callbacks da Execução para o OS** (ações do mecânico na API/UI da Execução):

| Ação do mecânico na Execução | Callback `type` | `data` |
|---|---|---|
| `POST /execucao/ordens/{numeroOS}/diagnostico` com `{ diagnostico }` (5 a 1000 caracteres, mesma regra do OS). Antes, o mecânico se atribui e vincula serviços e peças pelas rotas da Execução. **Baixa o estoque** numa transação; `409 { motivo }` ao mecânico se faltar peça | `execucao.diagnostico-concluido` | `{ numeroOS, mecanicoId, diagnostico, itens[] }` (`Item`: `tipo`, `referenciaId`, `nome`, `quantidade`, `precoUnitario`, `servicoId` nos PRODUTOs) |
| `POST /execucao/ordens/{numeroOS}/finalizar` | `execucao.finalizada` | `{ numeroOS, finalizadaEm }` |

## OS Service → Billing Service

| Comando | Endpoint no Billing | Corpo | Resposta imediata = evento | Falha de negócio |
|---|---|---|---|---|
| `billing.gerar-orcamento` | `POST /orcamentos` | `{ numeroOS, clienteId, itens[] }` | `201 { numeroOS, orcamentoId, total, validoAte }` ≙ `billing.orcamento-gerado`; orçamento ativo já existente → `200` com o mesmo corpo | — (o OS também aceita `409` com o orçamento existente no corpo e trata como sucesso) |
| `billing.cobrar` | `POST /orcamentos/{numeroOS}/cobrar` | — | `201 { numeroOS, orderId, linkPagamento, valor }` ≙ `billing.cobranca-criada` (order no Mercado Pago) | `409 { motivo }` se o orçamento não está aprovado |
| `billing.cancelar-orcamento` | `DELETE /orcamentos/{numeroOS}` | `{ motivo }` | `200 { numeroOS, orcamentoId, estornado }` ≙ `billing.orcamento-cancelado` (idempotente; `orcamentoId: null` se a OS foi cancelada antes de o orçamento existir) | `409 { motivo }` se o pagamento já foi aprovado — inalcançável pela saga, que só compensa antes de `billing.cobrar` |

**Callbacks do Billing para o OS:**

| Origem no Billing | Callback `type` | `data` |
|---|---|---|
| Cliente aprova: `POST /orcamentos/{numeroOS}/aprovar` (CLIENTE, via gateway) | `billing.orcamento-aprovado` | `{ numeroOS, orcamentoId }` |
| Cliente rejeita: `POST /orcamentos/{numeroOS}/rejeitar` | `billing.orcamento-rejeitado` | `{ numeroOS, orcamentoId, motivo? }` |
| Webhook do Mercado Pago `order.processed` aprovado | `billing.pagamento-aprovado` | `{ numeroOS, orderId, valor }` |
| Webhook recusado / cancelado | `billing.pagamento-recusado` | `{ numeroOS, orderId, motivo }` |

## OS Service (o que recebe e o que expõe)

- `POST /ordens-servico/{numero}/eventos` — callback (role `SERVICO`). `200 { aplicado, duplicado?, passo, status }` (`passo`/`status` só faltam se a saga não existir mais); `400` envelope inválido ou `data.numeroOS` ≠ `{numero}`; `401`/`403` sem JWT de `SERVICO`; `404` OS inexistente (não repetir); `409` conflito de versão (releia e repita). Os `4xx` do OS usam o corpo padrão do Nest `{ statusCode, message, error? }` — o `409 { motivo }` dos princípios é a recusa de negócio dos participantes, não o conflito do callback.
- Eventos `os.aberta`, `os.cancelada`, `os.finalizada`, `os.entregue` deixam de ser publicados: a Notificação é **in-process** no OS Service (US-F4-12), alimentada pelos callbacks (ex.: `billing.cobranca-criada` → e-mail com `linkPagamento`).
- Nenhum outro serviço precisa ser avisado de `os.cancelada`: o cancelamento chama `DELETE /execucao/ordens/{numeroOS}` e `DELETE /orcamentos/{numeroOS}` diretamente (compensações).

## Fluxo (caminho feliz, pagamento após a execução)

1. `POST /ordens-servico` (ATENDENTE) → OS cria a OS e chama `POST /execucao/ordens` → `201` ≙ `execucao.enfileirada` → OS `EM_DIAGNOSTICO`.
2. Mecânico diagnostica na Execução → callback `execucao.diagnostico-concluido` → OS grava o snapshot e chama `POST /orcamentos` → `201` ≙ `billing.orcamento-gerado` → OS `AGUARDANDO_APROVACAO`; notifica o cliente.
3. Cliente aprova no Billing → callback `billing.orcamento-aprovado` → OS chama `POST /execucao/ordens/{n}/iniciar` → `200` ≙ `execucao.iniciada` → OS `EM_EXECUCAO`. (Revisão de 09/11: a baixa de estoque já aconteceu no fechamento do diagnóstico; o `DELETE` devolve o que foi baixado.)
4. Mecânico finaliza → callback `execucao.finalizada` → OS `AGUARDANDO_PAGAMENTO` e chama `POST /orcamentos/{n}/cobrar` → `201` ≙ `billing.cobranca-criada` → notifica o cliente com o link.
5. Cliente paga no Mercado Pago → webhook no Billing → callback `billing.pagamento-aprovado` → OS `FINALIZADA`.
6. Atendente entrega (`POST /ordens-servico/{id}/entregar`) → `ENTREGUE`.

Compensações: mesma matriz da US-F4-11, com os `DELETE` acima no lugar dos comandos de fila.

## O que muda em cada repositório

| Repo | Mudança |
|---|---|
| kit | `Role.SERVICO`; `@guilhermeqmaia/oficina-kit/http`: cliente HTTP interno com timeout, retry/backoff, JWT de serviço e propagação de correlação; `mintServiceToken` em `testing`; módulo `messaging` marcado como descontinuado (fica no pacote por compatibilidade). |
| OS Service | Remove outbox/poller/consumer/handlers SQS; `OrquestradorSagaService` chama Execução/Billing por HTTP e converte respostas em eventos; controller de callback; `processed_messages` continua para dedup de callbacks; LocalStack sai do compose. |
| Execução / Billing | Expõem os endpoints acima; chamam o callback do OS; sem fila. |
| infra-k8s | Remove o stage `messaging/`; gateway ganha o prefixo da Execução; nada de SNS/SQS nas vars. |
| infra-db | Sem mudança. |
