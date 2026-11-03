# Runbook — DLQ da mensageria e saga travada

Aplica-se a Fase 4 (RFC-0006, ADR-0009, US-F4-11). Principio (licao do *mortician* do
Nubank): mensagem na DLQ e **triagem humana**, nunca descarte.

## Quando este runbook dispara

| Sinal | Origem |
|---|---|
| Alarme `<fila>-dlq-nao-vazia` (CloudWatch, `ApproximateNumberOfMessagesVisible >= 1`) | stage `messaging/` do infra-k8s, topico SNS `oficina-messaging-alerts` |
| Gauge `oficina_os_sagas_paradas > 0` por mais de 15 min | OS Service, `/metrics` (SAGA_ALERTA_PARADA_MIN, padrao 60 min) |
| Saga `COMPENSANDO` ha mais de 1 h | `GET /ordens-servico/numero/:numero/saga` |

Filas e DLQs (nomes com prefixo `oficina`): `os-eventos` (consumida pelo OS Service),
`execucao-comandos` (Execucao), `billing-comandos` (Billing), `notificacao-eventos`.
Toda fila tem `<fila>-dlq.fifo` com `maxReceiveCount = 5` e visibility timeout de 30 s —
ou seja, 5 tentativas com backoff do proprio SQS antes de a mensagem cair na DLQ.

## 1. Triagem (o que caiu e por que)

```bash
export AWS_PROFILE=oficina AWS_REGION=us-east-1
DLQ=$(aws ssm get-parameter --name /oficina/messaging/queues/os_eventos/dlq_url --query Parameter.Value --output text)
aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessagesVisible
# espiar sem consumir (visibility 0 -> a mensagem continua disponivel)
aws sqs receive-message --queue-url "$DLQ" --max-number-of-messages 10 --visibility-timeout 0 \
  --message-attribute-names All --query 'Messages[].{id:MessageId,type:MessageAttributes.type.StringValue,os:MessageAttributes.correlationId.StringValue,body:Body}'
```

Classifique cada mensagem:

| Causa | Como reconhecer | Acao |
|---|---|---|
| **Envelope invalido** (sem `id`, `type` fora do padrao) | log `envelope invalido — mensagem ira para a DLQ` no consumidor | Corrigir o produtor; **apagar** da DLQ (reprocessar nao vai ajudar) |
| **Sem handler** para o `type` | log `sem handler para o type` | Ajustar a filter policy (infra-k8s `messaging/`) ou registrar o handler; depois redrive |
| **Evento fora de ordem / incompativel** (`InvalidStatusTransitionError`) | log `falha ao processar — sera reentregue` com o erro de transicao | Ver a saga (`GET .../saga`); se o passo esperado ja passou, **apagar** (a saga ignora duplicados); se faltou um evento anterior, redrive **depois** de ele chegar |
| **OS/saga inexistente** (`OrdemDeServicoNotFoundError`) | idem, erro "nao encontrada" | Numero errado no produtor — corrigir e apagar |
| **Falha de plataforma** (banco fora, timeout) | erros de conexao/timeout; varias mensagens de uma vez | Resolver a causa e **redrive** de tudo |

## 2. Redrive (voltar da DLQ para a fila de origem)

```bash
SRC_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)
aws sqs start-message-move-task --source-arn "$SRC_ARN"            # tudo, para a fila de origem
aws sqs list-message-move-tasks --source-arn "$SRC_ARN"            # acompanhar
```

Para reprocessar **uma** mensagem especifica: `receive-message` na DLQ, `send-message` na
fila de origem com o **mesmo corpo**, `--message-group-id <numero da OS>` e
`--message-deduplication-id <id do envelope>`, e `delete-message` na DLQ. O consumidor
e idempotente (`processed_messages` + saga ignora duplicados), entao reenviar nunca
aplica duas vezes.

Local (LocalStack): mesmos comandos com `awslocal` (ver `docs/mercado-pago-sandbox.md`
e `scripts/messaging-local.sh`).

## 3. Saga travada (sem mensagem na DLQ)

Sintoma: `oficina_os_sagas_paradas > 0` ou saga `EM_ANDAMENTO` parada em
`ENFILEIRAR_EXECUCAO`, `GERAR_ORCAMENTO`, `INICIAR_EXECUCAO` ou em `COMPENSANDO` sem
confirmacao. O comando saiu, mas o participante nao respondeu (ou respondeu e a
resposta esta na DLQ dele — ver item 1 na fila do outro servico).

```bash
GW=https://<api-id>.execute-api.us-east-1.amazonaws.com
curl -s $GW/ordens-servico/numero/$NUMERO/saga -H "Authorization: Bearer $TOKEN_ADMIN" | jq '{passo,status,compensacoes,historico:.historico[-3:]}'
curl -s -X POST $GW/admin/sagas/$NUMERO/reprocessar -H "Authorization: Bearer $TOKEN_ADMIN" | jq '{reenviados, passo:.saga.passo}'
```

`reprocessar` reenvia pelo outbox o comando do passo atual (`execucao.enfileirar`,
`billing.gerar-orcamento` com o snapshot da OS, `execucao.iniciar`) ou as compensacoes
nao confirmadas. Nao altera a OS. Em passos que aguardam cliente/participante devolve
`reenviados: []` — ai o problema esta no outro servico (ou e um timeout de negocio,
que o relogio da saga trata sozinho).

Comandos reenviados sao idempotentes nos participantes (AsyncAPI: `summary` de
`execucao.liberar-reservas` e `billing.cancelar-orcamento`).

## 4. Nunca

- Apagar a DLQ "para limpar o alarme" sem classificar.
- Editar `saga_os` ou `ordem_de_servico` a mao: use `reprocessar`, `cancelar` ou o relogio.
- Desligar o alarme: ele e o unico sinal de mensagem perdida.
