# Runbook — alerta "Latência p95 entre serviços acima de 2 s"

Monitor `datadog_monitor.latencia_entre_servicos` (infra-k8s `observability/monitors.tf`, US-F4-16). Severidade: **aviso** (> 1 s) / **crítico** (> 2 s).

## Quando dispara

`avg(last_10m)` do p95 de `oficina_http_interno_duracao_seconds` por `origem`/`destino` acima de 2 s.
A duração é medida por quem chama e **inclui as retentativas e o backoff** do cliente do kit
(200 ms + 800 ms + 3 s), então p95 alto pode ser destino lento **ou** muitas tentativas.

## O que significa

As chamadas do orquestrador ficam lentas, e com elas a requisição do usuário que disparou o passo
(abrir OS, callback do mecânico/cliente) — o OS executa os comandos antes de responder. Acima de
5 s por tentativa vira timeout e, em 3 tentativas, **retry esgotado**.

## Triagem

1. Dashboard **"Oficina — Fluxo distribuído"** → "Latência p95 por par" (qual par) e
   "Chamadas entre serviços por rota e resultado" (qual `rota`; `status` no histograma mostra se
   houve 5xx/`sem_resposta` junto).
2. Tentativas: logs `chamada interna falhou — nova tentativa` com `correlationId` = OS. Muitas
   linhas → o problema é erro intermitente, não lentidão pura.
3. Trace no APM: abrir um trace lento filtrando `correlation_id:<numero>` e ver o span `http.client`
   do os-service e o span do destino (banco, Mercado Pago no Billing, DynamoDB na Execução).
4. Recursos do destino: CPU/memória e réplicas no dashboard "Saúde técnica"; HPA no máximo?

## Ação

- Destino saturado: escalar (`kubectl -n oficina scale deploy/<destino> --replicas=N`) ou revisar o HPA.
- Dependência externa lenta (Mercado Pago, DynamoDB): confirmar status do provedor; o fluxo continua
  (retry), mas acompanhe o alerta de retry esgotado.
- Query lenta no destino: abrir correção no serviço (o trace mostra o span).

## Nunca

- Subir o timeout de 5 s do cliente interno para esconder a latência.
