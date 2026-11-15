# Runbook — alerta "Saga de OS parada"

Monitor `datadog_monitor.saga_parada` (infra-k8s `observability/monitors.tf`, US-F4-16). Severidade: **crítico**.
A ação de correção está em [`saga-reprocessar.md`](saga-reprocessar.md); este runbook é a porta de entrada do alerta.

## Quando dispara

| Sinal | Detalhe |
|---|---|
| `oficina_os_sagas_paradas > 0` durante `saga_alerta_parada_min` | var do Terraform, igual a `SAGA_ALERTA_PARADA_MIN` do os-service (padrão 60 min) |
| O que a gauge conta | só **falha da plataforma**: sagas `EM_ANDAMENTO` num passo automático (`ENFILEIRAR_EXECUCAO`, `GERAR_ORCAMENTO`, `INICIAR_EXECUCAO`, `COBRAR`) ou `COMPENSANDO` há mais de `SAGA_ALERTA_PARADA_MIN` **e**, na hora, sagas `EM_ANDAMENTO`/`COMPENSANDO` com comando não entregue em `falhasPendentes` (retry esgotado, US-F4-18 — estado da saga, não a última entrada do histórico: uma confirmação ou callback duplicado depois do `chamada-falhou` não a tira da contagem) |
| O que a gauge NÃO conta | espera por pessoa (`AGUARDAR_DIAGNOSTICO`, `AGUARDAR_APROVACAO`, `AGUARDAR_FINALIZACAO`, `AGUARDAR_PAGAMENTO`): vai para `oficina_os_sagas_aguardando_pessoa{passo}` (informativa, sem alerta crítico) |
| Atualização | o relógio da saga (`SagaTimeoutsService`) recalcula a cada `SAGA_TIMEOUTS_INTERVALO_MS` (60 s) |

## O que significa

Uma OS não avança por falha da plataforma: o participante não respondeu (retry esgotado) ou uma
compensação não foi confirmada. Espera longa por pessoa (aprovação/pagamento do cliente, mecânico) **não**
entra mais aqui (revisão de 15/11) — aparece em `oficina_os_sagas_aguardando_pessoa`. Callback perdido
num passo de espera por pessoa também só aparece nessa gauge: se ela crescer num passo, confira no
participante (item 3 de [`saga-reprocessar.md`](saga-reprocessar.md)).

## Triagem (5 min)

1. Dashboard **"Oficina — Fluxo distribuído"**: "Sagas paradas agora", "Sagas por passo" e
   "Chamadas entre serviços por rota e resultado". Se houver `esgotado` no mesmo período, o alerta
   **retry esgotado** ([`retry-esgotado.md`](retry-esgotado.md)) é a causa.
2. Logs do os-service filtrando `chamada-falhou` ou `msg:"comando nao entregue*"` → `correlation_id`
   (= número da OS), `destino`, `rota`, `tentativa`.
3. Para cada OS:
   ```bash
   curl -s $GW/ordens-servico/numero/$NUMERO/saga -H "Authorization: Bearer $TOKEN_ADMIN" \
     | jq '{passo,status,falhasPendentes,historico:.historico[-5:]}'
   ```
   - `falhasPendentes` não vazio (comando, passo, `tentativas`) → o participante falhou: resolver e **reprocessar**;
   - passo automático ou `COMPENSANDO` sem falha pendente → resposta não aplicada (log
     `resposta do participante nao aplicada na saga`) ou compensação sem confirmação: **reprocessar**.

## Ação

Seguir [`saga-reprocessar.md`](saga-reprocessar.md): item 2 (reprocessar) para `chamada-falhou` e
compensações pendentes; item 3 (callback perdido) quando o participante já avançou.
Depois do reprocessamento a saga sai da gauge no próximo ciclo do relógio (≤ 60 s) e o monitor volta a OK.

## Escalar

- Mais de 5 sagas paradas no mesmo passo → problema sistêmico no participante daquele passo (time dono do serviço).
- Saga volta a parar logo após reprocessar → não reprocessar de novo antes de achar a causa.

## Nunca

- Editar `saga_os`/`ordem_de_servico` a mão ou silenciar o monitor (é o único sinal de chamada/callback perdido).
