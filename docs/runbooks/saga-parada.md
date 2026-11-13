# Runbook — alerta "Saga de OS parada"

Monitor `datadog_monitor.saga_parada` (infra-k8s `observability/monitors.tf`, US-F4-16). Severidade: **crítico**.
A ação de correção está em [`saga-reprocessar.md`](saga-reprocessar.md); este runbook é a porta de entrada do alerta.

## Quando dispara

| Sinal | Detalhe |
|---|---|
| `oficina_os_sagas_paradas > 0` durante `saga_alerta_parada_min` | var do Terraform, igual a `SAGA_ALERTA_PARADA_MIN` do os-service (padrão 60 min) |
| O que a gauge conta | sagas `EM_ANDAMENTO` no mesmo passo há mais de `SAGA_ALERTA_PARADA_MIN` **e**, na hora, sagas `EM_ANDAMENTO`/`COMPENSANDO` cuja última entrada do histórico é `chamada-falhou` (retry esgotado, US-F4-18) |
| Atualização | o relógio da saga (`SagaTimeoutsService`) recalcula a cada `SAGA_TIMEOUTS_INTERVALO_MS` (60 s) |

## O que significa

Uma OS não avança: o participante não respondeu, uma compensação não foi confirmada ou um callback
se perdeu. Também entra aqui a espera longa por pessoa (aprovação do cliente, mecânico): nesse caso
não é falha — confirme antes de agir.

## Triagem (5 min)

1. Dashboard **"Oficina — Fluxo distribuído"**: "Sagas paradas agora", "Sagas por passo" e
   "Chamadas entre serviços por rota e resultado". Se houver `esgotado` no mesmo período, o alerta
   **retry esgotado** ([`retry-esgotado.md`](retry-esgotado.md)) é a causa.
2. Logs do os-service filtrando `chamada-falhou` ou `msg:"comando nao entregue*"` → `correlation_id`
   (= número da OS), `destino`, `rota`, `tentativa`.
3. Para cada OS:
   ```bash
   curl -s $GW/ordens-servico/numero/$NUMERO/saga -H "Authorization: Bearer $TOKEN_ADMIN" \
     | jq '{passo,status,historico:.historico[-5:]}'
   ```
   - última entrada `chamada-falhou` (com `tentativas`) → o participante falhou: resolver e **reprocessar**;
   - `AGUARDAR_*` sem `chamada-falhou` → espera por pessoa ou callback perdido.

## Ação

Seguir [`saga-reprocessar.md`](saga-reprocessar.md): item 2 (reprocessar) para `chamada-falhou` e
compensações pendentes; item 3 (callback perdido) quando o participante já avançou.
Depois do reprocessamento a saga sai da gauge no próximo ciclo do relógio (≤ 60 s) e o monitor volta a OK.

## Escalar

- Mais de 5 sagas paradas no mesmo passo → problema sistêmico no participante daquele passo (time dono do serviço).
- Saga volta a parar logo após reprocessar → não reprocessar de novo antes de achar a causa.

## Nunca

- Editar `saga_os`/`ordem_de_servico` a mão ou silenciar o monitor (é o único sinal de chamada/callback perdido).
