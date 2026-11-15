# Runbook — alerta "Callbacks recebendo 409 repetidamente"

Monitor `datadog_monitor.callback_conflito_repetido` (infra-k8s `observability/monitors.tf`, US-F4-16). Severidade: **aviso**.

## Quando dispara

Mais de 3 callbacks com `oficina_callbacks_total{resultado="conflito"}` em 15 min, por `type`.
`conflito` = `POST /ordens-servico/{numero}/eventos` respondeu **409**: o orquestrador refez a
transação 3 vezes (lock otimista da saga/OS) e o conflito de versão continuou.

## O que significa

Concorrência anormal na mesma OS: callbacks do mesmo fato em rajada (retry agressivo do
participante), o relógio da saga aplicando timeout ao mesmo tempo, ou duas réplicas processando a
mesma OS. Pelo contrato o participante relê e repete (3x); se desistir, a OS para e o alerta
**saga parada** aparece. Um 409 isolado é esperado e não preocupa.

## Triagem

1. Logs do os-service: `msg:"callback recebido" resultado:conflito` → `correlation_id` (OS), `type`,
   `id`, `producer`, `tentativa` (header `x-tentativa`, quando o participante envia). Em seguida
   `msg:"conflito de versao — refazendo"` para ver as tentativas internas.
2. Mesmo `correlation_id` em muitas linhas → uma OS em disputa; muitas OS diferentes → problema geral
   (banco lento segurando transações, réplicas demais do varredor).
3. Estado da OS:
   ```bash
   curl -s $GW/ordens-servico/numero/$NUMERO/saga -H "Authorization: Bearer $TOKEN_ADMIN" | jq '{passo,status,historico:.historico[-5:]}'
   ```

## Ação

- Se a saga já avançou (o retry do participante acabou aplicando): nada a fazer; acompanhar a queda do contador.
- Se a OS parou: seguir [`saga-parada.md`](saga-parada.md) / [`saga-reprocessar.md`](saga-reprocessar.md) item 3
  (reenviar o callback com o mesmo `id` — o OS deduplica).
- Participante repetindo sem backoff: abrir correção no serviço produtor (retry com backoff do kit).
- Latência do banco do OS alta (RDS): ver o dashboard técnico; o lock otimista sofre com transações longas.

## Nunca

- Remover o lock otimista (`version`) ou marcar o `id` como processado a mão em `processed_messages`.
