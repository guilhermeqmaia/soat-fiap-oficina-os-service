#!/usr/bin/env bash
# Topologia de mensageria (RFC-0006) no LocalStack — mesma dos stages
# Terraform `messaging/` do infra-k8s: 3 topicos FIFO por produtor, uma fila
# FIFO por consumidor com DLQ, assinaturas com filtro por `type`.
# Roda dentro do container (init hook) ou localmente com `awslocal` no PATH.
set -euo pipefail
AWS=${AWSLOCAL:-awslocal}
ACCOUNT=000000000000
REGION=${AWS_DEFAULT_REGION:-us-east-1}

topic() { $AWS sns create-topic --name "$1.fifo" --attributes FifoTopic=true,ContentBasedDeduplication=false --query TopicArn --output text; }
queue() { # nome -> url (cria DLQ + fila com redrive)
  local dlq; dlq=$($AWS sqs create-queue --queue-name "$1-dlq.fifo" --attributes FifoQueue=true --query QueueUrl --output text)
  local dlqArn="arn:aws:sqs:$REGION:$ACCOUNT:$1-dlq.fifo"
  $AWS sqs create-queue --queue-name "$1.fifo" --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlqArn\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" --query QueueUrl --output text >/dev/null
  echo "arn:aws:sqs:$REGION:$ACCOUNT:$1.fifo"
}
subscribe() { # topicArn queueArn types(csv)
  local filter; filter=$(printf '{"type":[%s]}' "$(echo "$3" | sed 's/[^,]*/"&"/g')")
  $AWS sns subscribe --topic-arn "$1" --protocol sqs --notification-endpoint "$2" --attributes "{\"FilterPolicy\":\"$(echo "$filter" | sed 's/"/\\"/g')\",\"RawMessageDelivery\":\"true\"}" >/dev/null
}

OS=$(topic oficina-os); EX=$(topic oficina-execucao); BI=$(topic oficina-billing)
EXC=$(queue execucao-comandos); BIC=$(queue billing-comandos); OSE=$(queue os-eventos); NOT=$(queue notificacao-eventos)

# comandos do orquestrador (publicados no topico do OS Service)
subscribe "$OS" "$EXC" "execucao.enfileirar,execucao.iniciar,execucao.liberar-reservas"
subscribe "$OS" "$BIC" "billing.gerar-orcamento,billing.cobrar,billing.cancelar-orcamento"
# eventos dos participantes -> orquestrador
subscribe "$EX" "$OSE" "execucao.enfileirada,execucao.recusada,execucao.diagnostico-concluido,execucao.iniciada,execucao.finalizada,execucao.reservas-liberadas"
subscribe "$BI" "$OSE" "billing.orcamento-gerado,billing.orcamento-aprovado,billing.orcamento-rejeitado,billing.cobranca-criada,billing.pagamento-aprovado,billing.pagamento-recusado,billing.orcamento-cancelado"
# notificacao (coreografada)
subscribe "$BI" "$NOT" "billing.orcamento-gerado,billing.orcamento-aprovado,billing.cobranca-criada,billing.pagamento-aprovado,billing.pagamento-recusado"
subscribe "$OS" "$NOT" "os.aberta,os.finalizada,os.cancelada,os.entregue"

echo "mensageria local pronta: topicos oficina-{os,execucao,billing}.fifo · filas execucao-comandos, billing-comandos, os-eventos, notificacao-eventos (+ DLQs)"
