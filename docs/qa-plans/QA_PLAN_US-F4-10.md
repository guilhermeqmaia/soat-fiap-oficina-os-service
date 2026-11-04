# QA Plan — US-F4-10: Saga Orquestrada da Ordem de Servico

## Resumo
Valida o orquestrador da saga no OS Service (RFC-0005): estado persistido em `saga_os`, comandos enviados via outbox a cada passo, avanco so com o evento esperado, eventos duplicados/fora de ordem ignorados, compensacoes com confirmacao, timeout de aprovacao (pagamento em atraso so registra), cobranca apos a execucao (`billing.cobrar` / `billing.cobranca-criada`), linha do tempo em `GET /ordens-servico/numero/:numero/saga` e metricas.

## Pre-requisitos
- Docker (testcontainers) para integracao/e2e; `npm ci && npx prisma generate`
- Migration `20261021000000_saga_os`
- Para a demo ponta a ponta: LocalStack (`docker compose --profile messaging up -d localstack`) e os servicos Execucao/Billing (US-F4-07/08) consumindo `execucao-comandos` / `billing-comandos`

## Cenarios de Teste

### TS-01: Abertura inicia a saga
- **Tipo:** Automatizado (e2e "abrir a OS inicia a saga")
- **Criterio:** Tabela `saga_os`; comando via outbox
- **Passos:** `POST /ordens-servico`; `SELECT * FROM saga_os WHERE numero = ...`; `SELECT type FROM outbox WHERE correlation_id = ...`
- **Resultado esperado:** saga `ENFILEIRAR_EXECUCAO`/`EM_ANDAMENTO`; outbox com `os.aberta` e `execucao.enfileirar` (`veiculoId`, `descricaoProblema`)

### TS-02: Caminho feliz passo a passo
- **Tipo:** Automatizado (`saga-os.entity.spec.ts` "caminho feliz"; e2e "caminho feliz")
- **Criterio:** Passos em ordem; transicoes da OS ligadas aos passos
- **Passos:** entregar `execucao.enfileirada` -> `diagnostico-concluido` -> `billing.orcamento-gerado` -> `orcamento-aprovado` -> `execucao.iniciada` -> `execucao.finalizada` -> `billing.cobranca-criada` -> `billing.pagamento-aprovado`; atendente entrega
- **Resultado esperado:** OS EM_DIAGNOSTICO -> AGUARDANDO_APROVACAO -> (inalterada na aprovacao) -> EM_EXECUCAO -> AGUARDANDO_PAGAMENTO -> FINALIZADA -> ENTREGUE; comandos `billing.gerar-orcamento` (itens do diagnostico, `causationId`), `execucao.iniciar` e `billing.cobrar`; `os.finalizada` so no pagamento aprovado; saga `CONCLUIDA` com 9 entradas no historico

### TS-03: Idempotencia e ordem
- **Tipo:** Automatizado (entity "duplicado e fora de ordem"; e2e "evento duplicado/fora de ordem")
- **Criterio:** Duplicados/fora de ordem ignorados com log
- **Passos:** reenviar `execucao.enfileirada`; enviar `execucao.iniciada` em `AGUARDAR_DIAGNOSTICO`
- **Resultado esperado:** `aplicado: false`, historico com `ignorado` e motivo; OS e passo inalterados; nenhum comando

### TS-04: Compensacoes (matriz)
- **Tipo:** Automatizado (entity "compensacoes"; e2e "orcamento rejeitado", "pagamento recusado", "falha ao iniciar execucao", "cancelamento manual em cada passo")
- **Criterio:** Compensacoes em ordem inversa, registradas e confirmadas
- **Passos:** `execucao.recusada` em ENFILEIRAR; `billing.orcamento-rejeitado`; `execucao.recusada` em INICIAR_EXECUCAO; `POST :id/cancelar` em cada passo ate INICIAR_EXECUCAO (tabela no e2e); `billing.pagamento-recusado` em AGUARDAR_PAGAMENTO
- **Resultado esperado:** OS CANCELADA com o motivo da matriz; comandos `billing.cancelar-orcamento` e/ou `execucao.liberar-reservas` (nunca estorno); saga `COMPENSANDO` ate as confirmacoes (`billing.orcamento-cancelado`, `execucao.reservas-liberadas`) e entao `CANCELADA`; cancelar apos `execucao.iniciada` ou em AGUARDANDO_PAGAMENTO -> 400; pagamento recusado **nao** compensa: OS segue AGUARDANDO_PAGAMENTO, historico `pagamento-pendente`

### TS-05: Timeouts
- **Tipo:** Automatizado (entity "timeouts"; orquestrador "SagaTimeoutsService"; e2e "timeout de aprovacao" e "timeout de pagamento")
- **Criterio:** Orcamento sem resposta -> compensacao; pagamento em atraso (pos-execucao) -> so registro + alerta
- **Passos:** `SAGA_TIMEOUT_APROVACAO_MS=1`; chegar a AGUARDAR_APROVACAO; `SagaTimeoutsService.varrer(agora)`; `SAGA_TIMEOUT_PAGAMENTO_MS=1`; chegar a AGUARDAR_PAGAMENTO; varrer
- **Resultado esperado:** OS CANCELADA `TIMEOUT_APROVACAO`; compensacoes enviadas; gauge `oficina_os_sagas{status}` atualizada. No pagamento: OS continua AGUARDANDO_PAGAMENTO, historico `ignorado` com detalhe `pagamento em atraso`, saga `EM_ANDAMENTO`, `oficina_os_sagas_paradas` cobre o alerta

### TS-06: Linha do tempo
- **Tipo:** Automatizado (e2e) + Manual (video)
- **Criterio:** `GET /ordens-servico/numero/:numero/saga`
- **Passos:** chamar com ADMIN/ATENDENTE/MECANICO; com CLIENTE; numero inexistente
- **Resultado esperado:** `{ passo, status, historico[], compensacoes[], prazoAprovacao, prazoPagamento }`; 403 para CLIENTE; 404 sem saga

### TS-07: Metricas
- **Tipo:** Manual
- **Criterio:** `oficina_os_saga_passos_total`, duracao por passo, sagas em compensacao
- **Passos:** percorrer uma saga e `curl /metrics | grep oficina_os_saga`
- **Resultado esperado:** `oficina_os_saga_passos_total{passo,resultado}` incrementa por evento; `oficina_os_saga_passo_duracao_seconds` observa ao sair do passo; `oficina_os_sagas{status="COMPENSANDO"}` > 0 durante compensacao

### TS-08: OS anterior a saga
- **Tipo:** Automatizado (orquestrador "OS sem saga e adotada"; e2e "OS sem saga e adotada")
- **Criterio:** Robustez
- **Passos:** OS sem linha em `saga_os` recebe `execucao.finalizada`
- **Resultado esperado:** saga adotada no passo equivalente ao status; evento aplicado; OS inexistente -> erro (DLQ)

### TS-09: Cobertura
- **Tipo:** Automatizado
- **Resultado esperado:** modulo `saga/` >= 90% no unitario

### TS-10: Consistencia transacional e conflitos
- **Tipo:** Automatizado (e2e "transacao unica"; orquestrador "refaz em conflito")
- **Criterio:** Nenhuma OS cancelada sem compensacao; nenhum comando sem passo
- **Passos:** forcar falha na gravacao da saga durante um evento; disparar dois eventos concorrentes sobre a mesma saga
- **Resultado esperado:** OS e saga ficam no estado anterior (rollback); conflito e refeito em processo (ate 3x) e depois devolve 409 (HTTP) ou reentrega (SQS)

### TS-11: Validacao manual com broker (20/10/2026)
- **Tipo:** Manual — app + Postgres + LocalStack (`docker compose --profile messaging`)
- **Resultado:** caminho feliz completo pelo SNS/SQS (comandos nas filas certas, snapshot, entrega), rejeicao com confirmacao, timeout de aprovacao (20 s), cancelamento manual com compensacao dupla, duplicado absorvido pelo dedup do SNS FIFO, fora de ordem ignorado, mensagem invalida na DLQ apos 5 tentativas, metricas em `/metrics`

## Casos de Borda
- Cancelamento manual durante `COMPENSANDO`: ignorado (a OS ja esta CANCELADA)
- Confirmacao de compensacao repetida: ignorada
- Dois pods: a saga tem lock otimista (`version`) — a segunda gravacao concorrente falha e o consumer reentrega
- `execucao.recusada` fora de ENFILEIRAR/INICIAR_EXECUCAO: ignorada (nao e um cenario da matriz)
- Prazos: entrar em AGUARDAR_APROVACAO zera o prazo de pagamento e vice-versa; compensacao limpa ambos; o prazo de pagamento nunca cancela (`TIMEOUT_PAGAMENTO` reservado/obsoleto)
- `billing.cobranca-criada` repetido em AGUARDAR_PAGAMENTO (nova cobranca apos `reprocessar`): registrado sem mudar passo nem OS

## Rastreabilidade
| Criterio | Cenarios |
|---|---|
| Tabela `saga_os` | TS-01, TS-08 |
| Passos em ordem | TS-02 |
| Comando via outbox + evento esperado + idempotencia | TS-01, TS-02, TS-03 |
| Transicoes da OS ligadas aos passos | TS-02, TS-04 |
| Timeouts | TS-05 |
| `GET .../saga` | TS-06 |
| Metricas | TS-07 |
| Testes >= 90% | TS-09 |

## Checklist de Validacao
- [x] TS-01..TS-06, TS-08, TS-09, TS-10 (21/10/2026)
- [x] TS-11 manual (20/10/2026)
- [ ] TS-07 — manual com `/metrics`
- [ ] Ponta a ponta com Execucao/Billing reais (apos US-F4-07/08)
