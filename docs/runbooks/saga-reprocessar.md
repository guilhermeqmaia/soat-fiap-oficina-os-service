# Runbook — saga parada e reprocessamento

Aplica-se a Fase 4 com o transporte HTTP (RFC-0008, US-F4-11, US-F4-18). Substitui o
runbook da DLQ (`saga-dlq-reprocessar.md`, historico no git): nao ha mais filas nem DLQ.
Principio: **nunca editar estado a mao** — use `reprocessar`, `cancelar` ou o relogio da saga.

## Quando este runbook dispara

| Sinal | Origem |
|---|---|
| Gauge `oficina_os_sagas_paradas > 0` por mais de `SAGA_ALERTA_PARADA_MIN` (padrao 60 min) | OS Service, `/metrics`; alerta "saga parada" (US-F4-16, [`saga-parada.md`](saga-parada.md)). A gauge conta na hora as sagas cuja ultima entrada e `chamada-falhou` |
| `oficina_http_interno_total{resultado="esgotado"}` incrementou (alerta "retry esgotado", [`retry-esgotado.md`](retry-esgotado.md)) | OS Service: uma chamada a Execucao/Billing falhou 3 vezes (`5xx`/timeout/rede) |
| Historico `chamada-falhou` (com `tentativas`) / logs `comando nao entregue — tentativas esgotadas` com `correlation_id` = numero da OS | OS Service (orquestrador) ou Billing/Execucao (callback nao entregue) |
| Saga `COMPENSANDO` ha mais de 1 h | `GET /ordens-servico/numero/:numero/saga` |
| Saga em `AGUARDAR_PAGAMENTO` com `pagamento-pendente` / `pagamento em atraso` | idem (pendencia de negocio, nao falha) |

## 1. Triagem (onde a saga parou e por que)

```bash
GW=https://<api-id>.execute-api.us-east-1.amazonaws.com
curl -s $GW/ordens-servico/numero/$NUMERO/saga -H "Authorization: Bearer $TOKEN_ADMIN" \
  | jq '{passo,status,passoDesde,compensacoes,historico:.historico[-5:]}'
```

| Passo parado | Significa | Acao |
|---|---|---|
| `ENFILEIRAR_EXECUCAO`, `GERAR_ORCAMENTO`, `INICIAR_EXECUCAO`, `COBRAR` (historico com `chamada-falhou`) | o OS chamou o participante e o retry esgotou (participante fora, `5xx`, timeout) | resolver a causa no participante (`kubectl -n oficina get pods`, `/health`, logs pelo `correlation_id`) e **reprocessar** (item 2) |
| `COMPENSANDO` sem `confirmadaEm` | um `DELETE /orcamentos/{n}` ou `DELETE /execucao/ordens/{n}` nao respondeu `200` | idem: resolver e reprocessar (os `DELETE` sao idempotentes) |
| `AGUARDAR_DIAGNOSTICO`, `AGUARDAR_APROVACAO`, `AGUARDAR_FINALIZACAO` | espera por pessoa; nao e falha — **salvo** se o participante registrou a acao e o callback nao chegou | conferir no participante (`GET /execucao/ordens/{n}`, `GET /orcamentos/{n}`); se o estado la ja avancou, o callback foi perdido: ver item 3 |
| `AGUARDAR_PAGAMENTO` com `pagamento-pendente` | pagamento recusado ou em atraso apos a execucao (nao compensa) | combinar com o cliente; `reprocessar` emite nova cobranca (`POST /orcamentos/{n}/cobrar`) |
| historico com `InvalidStatusTransitionError` / callback `409` repetido | callback fora de ordem ou concorrencia | normalmente se resolve sozinho (o participante repete apos backoff); se persistir, ver a OS e o participante |

Log util nos tres servicos: filtrar por `correlation_id:<numero>`; `tentativa` e `rota` mostram cada chamada.

## 2. Reprocessar (repete a chamada HTTP do passo)

```bash
curl -s -X POST $GW/admin/sagas/$NUMERO/reprocessar -H "Authorization: Bearer $TOKEN_ADMIN" \
  | jq '{reenviados, passo:.saga.passo, status:.saga.status}'
```

`reprocessar` repete a chamada do passo atual (`POST /execucao/ordens`, `POST /orcamentos`
com o snapshot da OS, `POST /execucao/ordens/{n}/iniciar`, `POST /orcamentos/{n}/cobrar`) ou
as compensacoes nao confirmadas (`DELETE ...`). Nao altera a OS. Em passos que aguardam
pessoa devolve `reenviados: []` — ai o problema esta no outro servico (item 3) ou e um prazo
de negocio que o relogio da saga trata sozinho. Todas as chamadas sao idempotentes por
`numeroOS`: repetir nunca duplica efeito (o participante devolve o resultado existente).

## 3. Callback perdido (participante avancou, OS nao soube)

Sintoma: a Execucao mostra `DIAGNOSTICADA`/`FINALIZADA` (ou o Billing `APROVADO`/`PAGO`) e a
saga continua em `AGUARDAR_*`. O participante tentou `POST /ordens-servico/{n}/eventos` 3x
e desistiu (log `callback nao entregue` no participante).

Opcoes, em ordem:

1. Endpoint de reenvio do participante, se existir (`POST /execucao/ordens/{n}/reenviar-callback`
   ou `POST /orcamentos/{n}/reenviar-callback`, ADMIN) — repete o callback com o **mesmo `id`**.
2. Reenviar o callback a mao com um JWT `SERVICO` (`mintServiceToken` do kit) copiando `type`,
   `data` e, se possivel, o `id` original do log do participante:

```bash
curl -s -X POST http://os-service:3000/ordens-servico/$NUMERO/eventos \
  -H "Authorization: Bearer $TOKEN_SERVICO" -H "x-correlation-id: $NUMERO" -H "Content-Type: application/json" \
  -d '{"id":"<uuid>","type":"execucao.finalizada","version":1,"occurredAt":"2026-11-03T18:00:00Z","producer":"execucao-service","data":{"numeroOS":"'$NUMERO'","finalizadaEm":"2026-11-03T18:00:00Z"}}'
```

O OS deduplica por `id` (`processed_messages`); um `id` novo com o mesmo fato tambem e seguro
porque a saga ignora eventos de passos ja concluidos.

## 4. Local (compose)

Mesmos comandos contra `http://localhost:3000` (OS), `:3001` (Billing), `:3002` (Execucao);
tokens com `mintToken`/`mintServiceToken` do kit `/testing`. Sem LocalStack.

## 5. Nunca

- Editar `saga_os`, `ordem_de_servico`, `orcamento` ou os itens do DynamoDB a mao.
- Desligar o alerta de saga parada: ele e o unico sinal de chamada/callback perdido.
- Reprocessar sem antes resolver a causa (o retry vai esgotar de novo).
