# QA Plan — US-F4-11: Compensacoes e Rollback Seguro da Saga

## Resumo
Valida a matriz passo -> falha -> compensacao do orquestrador, o registro das compensacoes em `saga_os`, o caminho retry -> DLQ -> runbook, o endpoint administrativo de reprocessamento e a injecao de falhas para a demo.

## Pre-requisitos
- Docker (testcontainers) para integracao/e2e; `npm ci && npx prisma generate`
- Migration `20261103000000_saga_falha_simulada`
- Para TS-05/TS-06 manuais: LocalStack (`docker compose --profile messaging up -d localstack`) ou o stage `messaging/` na AWS
- `SAGA_SIMULAR_FALHA_HABILITADO=true` para a injecao de falhas

## Cenarios de Teste

### TS-01: Matriz de compensacao, uma linha por teste
- **Tipo:** Automatizado (entity "compensacoes"; e2e "orcamento rejeitado", "timeout de aprovacao", "falha ao iniciar a execucao", "cancelamento manual em cada passo", "pagamento recusado mantem AGUARDANDO_PAGAMENTO")
- **Criterio:** Matriz implementada; compensacoes em ordem inversa e registradas
- **Passos:** provocar cada falha da matriz pelos handlers SQS
- **Resultado esperado:** OS `CANCELADA` com o motivo da linha; comandos de compensacao no outbox na ordem `billing.cancelar-orcamento`, `execucao.liberar-reservas` (sem estorno); `saga_os.compensacoes` com `enviadaEm`; saga `COMPENSANDO` ate as confirmacoes e `CANCELADA` depois. Linha "pagamento recusado / em atraso" (pos-execucao): **sem** compensacao — OS segue `AGUARDANDO_PAGAMENTO`, historico `pagamento-pendente`, saga `EM_ANDAMENTO` em `AGUARDAR_PAGAMENTO`; `POST :id/cancelar` -> 400

### TS-02: Injecao de falhas (demo)
- **Tipo:** Automatizado (entity "injecao de falhas"; orquestrador "falha simulada"; e2e "injecao de falhas")
- **Criterio:** `x-simular-falha=<passo>` em ambiente nao-produtivo
- **Passos:** `POST /ordens-servico` com header `x-simular-falha: AGUARDAR_APROVACAO` (flag ligada); percorrer ate `billing.orcamento-aprovado`. Tambem com `AGUARDAR_PAGAMENTO`, percorrendo ate `billing.pagamento-aprovado`
- **Resultado esperado:** em `AGUARDAR_APROVACAO` o evento e tratado como `billing.orcamento-rejeitado`; OS `CANCELADA` (`ORCAMENTO_REJEITADO`); compensacoes enviadas; `falhaSimulada` volta a `null`; historico com `falha-simulada`. Em `AGUARDAR_PAGAMENTO` o evento vira `billing.pagamento-recusado` e demonstra o pagamento pendente pos-execucao (OS segue `AGUARDANDO_PAGAMENTO`, sem compensacao). Header com valor invalido -> 400; flag desligada -> 400

### TS-03: Reprocessar saga travada
- **Tipo:** Automatizado (entity "reprocessar"; orquestrador "reprocessar"; e2e "POST /admin/sagas")
- **Criterio:** Endpoint interno ADMIN
- **Passos:** saga em `GERAR_ORCAMENTO`; `POST /admin/sagas/:numero/reprocessar` com ADMIN e com ATENDENTE; numero inexistente; saga em `AGUARDAR_PAGAMENTO` apos `billing.pagamento-recusado`
- **Resultado esperado:** 200 com `reenviados: ['billing.gerar-orcamento']` e o payload remontado do snapshot (itens com `servicoId`); outbox ganha o comando; OS inalterada; 403 para nao-ADMIN; 404 sem saga; em `COMPENSANDO` reenvia so as compensacoes nao confirmadas; em `COBRAR`/`AGUARDAR_PAGAMENTO` reenvia `billing.cobrar` (nova cobranca); nos demais passos de espera devolve `[]`

### TS-04: Retry e DLQ
- **Tipo:** Manual (LocalStack ou AWS)
- **Criterio:** Backoff pelo SQS e DLQ apos 5 tentativas
- **Passos:** publicar um envelope invalido no topico `oficina-execucao.fifo`; observar a fila `os-eventos`
- **Resultado esperado:** 5 logs `envelope invalido`, mensagem em `os-eventos-dlq.fifo`, alarme `os-eventos-dlq-nao-vazia` (AWS). Validado em 20/10 com LocalStack (QA_PLAN_US-F4-10 TS-11)

### TS-05: Runbook de redrive
- **Tipo:** Manual
- **Criterio:** Alarme -> runbook
- **Passos:** seguir `docs/runbooks/saga-reprocessar.md`: triagem com `receive-message --visibility-timeout 0`, `start-message-move-task`
- **Resultado esperado:** mensagem volta para a fila de origem e e consumida; duplicata e ignorada pelo consumidor (`processed_messages`/saga)

### TS-06: Saga parada sem DLQ
- **Tipo:** Manual
- **Criterio:** Retomada
- **Passos:** derrubar o consumidor da Execucao; abrir OS; esperar `oficina_os_sagas_paradas` (SAGA_ALERTA_PARADA_MIN curto); `reprocessar`; subir a Execucao
- **Resultado esperado:** `execucao.enfileirar` reenviado e processado uma unica vez

## Casos de Borda
- `reprocessar` em `AGUARDAR_DIAGNOSTICO`/`AGUARDAR_APROVACAO`/`AGUARDAR_FINALIZACAO`/`CONCLUIDA`/`CANCELADA`: `reenviados: []`, historico registra "nada a reenviar" (`AGUARDAR_PAGAMENTO` e a excecao: reenvia `billing.cobrar`)
- `x-simular-falha` em passo anterior ao marcado: eventos passam intactos ate chegar ao passo
- Injecao so afeta o evento de sucesso do passo; `execucao.recusada` real continua funcionando
- Reenvio de `billing.cancelar-orcamento` leva `motivo: OPERADOR` (compensacao manual)

## Rastreabilidade
| Criterio | Cenarios |
|---|---|
| Matriz implementada | TS-01 |
| Ordem inversa + registro em `saga_os` | TS-01 |
| Retry/backoff, DLQ, alarme, runbook | TS-04, TS-05 |
| `POST /admin/sagas/:numero/reprocessar` | TS-03, TS-06 |
| Injecao de falhas | TS-02 |
| Teste por linha da matriz | TS-01 |

## Checklist de Validacao
- [x] TS-01, TS-02, TS-03 (03/11/2026)
- [x] TS-04 (20/10/2026, LocalStack)
- [ ] TS-05, TS-06 — manual quando o ambiente AWS voltar
