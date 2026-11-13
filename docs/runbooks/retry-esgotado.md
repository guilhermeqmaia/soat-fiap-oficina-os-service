# Runbook — alerta "Chamada entre serviços com retry esgotado"

Monitor `datadog_monitor.retry_esgotado` (infra-k8s `observability/monitors.tf`, US-F4-16). Severidade: **crítico**.

## Quando dispara

`sum(last_5m)` de `oficina_http_interno_total{resultado="esgotado"} > 0`, agrupado por `origem`/`destino`.
`esgotado` = a chamada interna recebeu `5xx`, deu timeout (5 s por tentativa) ou erro de rede nas
**3 tentativas** do cliente HTTP do kit (backoff 200 ms, 800 ms, 3 s). `4xx` não repete e conta como
`recusa` (409) ou `erro` (outros) — não dispara este alerta.

## O que significa

O destino (`execucao-service` ou `billing-service`) está fora, lento ou quebrando. A saga da OS
ficou no passo com a entrada `chamada-falhou` (com `tentativas`) e passa a contar em
`oficina_os_sagas_paradas` — o alerta **saga parada** vem em seguida se nada for feito.

## Triagem

1. Dashboard **"Oficina — Fluxo distribuído"** → "Chamadas entre serviços por rota e resultado"
   (qual `rota`), "Latência p95 por par" e "5xx por serviço".
2. Saúde do destino:
   ```bash
   kubectl -n oficina get pods -l app.kubernetes.io/name=<destino>
   kubectl -n oficina logs deploy/<destino> --since=15m | grep -i error
   curl -s http://<destino>:<porta>/health/ready
   ```
3. Logs do os-service com `msg:"comando nao entregue — tentativas esgotadas"` → `correlation_id`
   (OS afetadas), `rota`, `status` (último HTTP; ausente = timeout/rede), `tentativa` = 3.
   As linhas `chamada interna falhou — nova tentativa` (do kit) mostram cada tentativa com o mesmo
   `correlationId`.

| Achado | Causa provável | Ação |
|---|---|---|
| sem `status` (timeout/rede) | pod fora, DNS/Service errado, NetworkPolicy | subir o destino / corrigir `EXECUCAO_SERVICE_URL`/`BILLING_SERVICE_URL` |
| `status` 503/502 | destino reiniciando, sem réplica pronta | aguardar rollout ou `kubectl rollout undo` |
| `status` 500 | bug ou banco do destino (RDS/DynamoDB) | runbook [`erros-5xx-por-servico.md`](erros-5xx-por-servico.md) |

## Ação

Com o destino saudável, reprocessar cada OS afetada (idempotente por `numeroOS`):
`POST /admin/sagas/:numero/reprocessar` — ver [`saga-reprocessar.md`](saga-reprocessar.md) item 2.

## Nunca

- Reprocessar em massa antes de o destino voltar (as tentativas esgotam de novo e o alerta repete).
- Aumentar timeout/tentativas para "calar" o alerta sem entender a causa.
