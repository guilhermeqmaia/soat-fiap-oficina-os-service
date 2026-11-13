# Runbook — alerta "5xx no {serviço}"

Monitor `datadog_monitor.erros_5xx_por_servico` (infra-k8s `observability/monitors.tf`, US-F4-16). Severidade: **crítico** (> 5 em 10 min) / aviso (> 2).

## Quando dispara

Mais de 5 respostas `5xx` em 10 min em `oficina_http_request_duration_seconds{status=~"5.."}`, por
`service` (`os-service`, `billing-service`, `execucao-service` — label que o `MetricsModule` do kit
põe em toda série). Complementa o monitor da Fase 3 "Falha no processamento de OS", que olha só as
rotas `/ordens-servico*`.

## O que significa

Exceção não tratada no serviço. Se o serviço é **destino** da saga (Billing/Execução), as chamadas do
OS repetem e podem esgotar ([`retry-esgotado.md`](retry-esgotado.md)); se é o **OS**, callbacks dos
participantes recebem 5xx e são repetidos por eles (contados em `oficina_callbacks_total{resultado="erro"}`).

## Triagem

1. Dashboard **"Oficina — Fluxo distribuído"** → "5xx por serviço"; **"Oficina — Saúde técnica"** →
   "Taxa de 5xx por rota" (qual rota).
2. Logs do serviço: `statusCode:5*` → `correlation_id`, `trace_id`, mensagem de erro. Pelo
   `trace_id` abrir o trace no APM.
3. Dependências:
   ```bash
   kubectl -n oficina get pods
   curl -s http://<servico>:<porta>/health/ready   # banco: RDS (OS/Billing) ou DynamoDB (Execução)
   kubectl -n oficina rollout history deploy/<servico>
   ```

| Achado | Ação |
|---|---|
| começou após um deploy | `kubectl -n oficina rollout undo deploy/<servico>` e abrir bug |
| `/health/ready` falhando no banco | ver RDS/DynamoDB (credenciais no Secret, conexões, throttling) |
| erro só numa rota/fluxo | abrir bug com o `trace_id`; se travou sagas, seguir [`saga-parada.md`](saga-parada.md) |

## Depois

Sagas que ficaram com `chamada-falhou` durante o incidente: reprocessar ([`saga-reprocessar.md`](saga-reprocessar.md) item 2).
