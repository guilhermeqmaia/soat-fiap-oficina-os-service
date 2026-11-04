# US-F4-11: Compensacoes e Rollback Seguro da Saga

**User Story:** Como Sistema, quero que qualquer falha em qualquer passo da saga dispare as compensacoes corretas (liberar reservas, cancelar orcamento, cancelar OS), para que nenhuma OS fique num estado inconsistente entre os servicos.

**Prioridade:** Alta
**Story Points:** 8
**Status:** Em revisão — implementada no OS Service (PR da US-F4-11). QA: [QA_PLAN_US-F4-11](../qa-plans/QA_PLAN_US-F4-11.md)
**DDD Domain:** Atendimento + Execucao + Billing
**DDD Layer:** Application
**Repositorio:** OS Service (orquestrador) + Execucao + Billing (acoes compensatorias)
**Revisao 03/11/2026:** transporte HTTP ([RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md), contrato em [`docs/contratos/http-interno.md`](../contratos/http-interno.md)) — codigo do OS Service sera refatorado na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)

## Contexto

Enunciado: "deve haver rollback e compensacao no caso de falha em qualquer
etapa". Aplicamos o criterio da AWS: falha de plataforma -> **retry**
(recuperacao para frente); falha de negocio -> **compensacao** (recuperacao
para tras). Toda compensacao e idempotente e pode ser reexecutada.

## Criterios de Aceite

- [x] Matriz passo -> falha -> compensacoes documentada e implementada (`saga/domain/saga-os.entity.ts`, metodo `compensar`; tabela abaixo):
  - enfileirar recusado -> OS `CANCELADA`
  - orcamento rejeitado -> `execucao.liberar-reservas` -> OS `CANCELADA`
  - timeout de aprovacao -> `billing.cancelar-orcamento` + `execucao.liberar-reservas` -> OS `CANCELADA`
  - falha ao iniciar execucao (aprovado, nao pago, nao executado) -> `billing.cancelar-orcamento` + liberar reservas (sem estorno) -> OS `CANCELADA`
  - pagamento recusado / em atraso (apos a execucao) -> **pendencia, nao compensacao**: OS permanece `AGUARDANDO_PAGAMENTO`, historico `pagamento-pendente`, alerta `oficina_os_sagas_paradas`, `reprocessar` reenvia `billing.cobrar`
- [x] Compensacoes enfileiradas em ordem inversa (executadas em paralelo pelos participantes, filas distintas) e registradas em `saga_os.compensacoes` com `enviadaEm`/`confirmadaEm`. **Revisao 03/11:** viram chamadas HTTP `DELETE /orcamentos/{n}` e `DELETE /execucao/ordens/{n}` em ordem inversa; `confirmadaEm` = resposta `200` (idempotente)
- [x] ~~Retry com backoff nos comandos (SQS visibility 30 s, `maxReceiveCount` 5) e **DLQ** com alarme~~ → **revisao 03/11:** retry/backoff no cliente HTTP do kit (3 tentativas: 200 ms, 800 ms, 3 s; so `5xx`/timeout/rede); **retry esgotado -> saga fica no passo -> alerta de saga parada (`oficina_os_sagas_paradas`) -> `reprocessar`**; runbook [`docs/runbooks/saga-reprocessar.md`](../runbooks/saga-reprocessar.md) (sem DLQ; nunca editar estado a mao)
- [x] Endpoint interno `POST /admin/sagas/:numero/reprocessar` (ADMIN): reenvia o comando do passo atual ou as compensacoes nao confirmadas (**revisao 03/11:** repete a chamada HTTP correspondente, idempotente por `numeroOS`); nao altera a OS
- [x] **Injecao de falhas para demo:** header `x-simular-falha=<passo>` no `POST /ordens-servico` (so com `SAGA_SIMULAR_FALHA_HABILITADO=true`): no passo marcado o evento de sucesso vira o de falha (`ENFILEIRAR_EXECUCAO`, `AGUARDAR_APROVACAO`, `INICIAR_EXECUCAO`; em `AGUARDAR_PAGAMENTO` demonstra o pagamento pendente pos-execucao); cartoes de teste do Mercado Pago cobrem a falha real de pagamento (`docs/mercado-pago-sandbox.md`)
- [x] Teste de integracao para cada linha da matriz (e2e `ordem-de-servico.e2e.spec.ts`, bloco "saga orquestrada": recusada, rejeitado, timeout de aprovacao, falha ao iniciar execucao, cancelamento manual por passo, pagamento recusado mantem `AGUARDANDO_PAGAMENTO` + reprocessar reenvia `billing.cobrar`, cancelamento rejeitado apos a execucao, injecao de falhas)
## APIs que expoe

| Metodo | Rota | Role | Corpo | Resposta |
|---|---|---|---|---|
| POST | `/admin/sagas/:numero/reprocessar` | ADMIN | — | `200 { reenviados: [comandos], saga: { passo, status } }` — repete a chamada HTTP do passo atual (`POST /execucao/ordens`, `POST /orcamentos`, `POST /execucao/ordens/{n}/iniciar`, `POST /orcamentos/{n}/cobrar`) ou as compensacoes nao confirmadas; nao altera a OS; `404` saga inexistente |
| POST | `/ordens-servico` (header `x-simular-falha=<passo>`) | ADMIN, ATENDENTE | so com `SAGA_SIMULAR_FALHA_HABILITADO=true` | `201`; no passo marcado o sucesso vira falha (demo) |
| POST | `/ordens-servico/:id/cancelar` | ADMIN, ATENDENTE | `{ motivo: "OPERADOR" }` | `201` OS `CANCELADA` apos as compensacoes do passo; `400` a partir de `AGUARDAR_FINALIZACAO` |
| GET | `/ordens-servico/numero/:numero/saga` | ADMIN, ATENDENTE, MECANICO | — | `200` com `compensacoes[] { comando, enviadaEm, confirmadaEm }` |

## APIs que consome

| Metodo | Rota (servico) | Compensacao | Corpo | Resposta esperada |
|---|---|---|---|---|
| DELETE | `/execucao/ordens/{numeroOS}` (Execucao) | `execucao.liberar-reservas` — tira da fila, aborta diagnostico, devolve reservas | `{ motivo }` | `200 { numeroOS }` ≙ `execucao.reservas-liberadas` (idempotente; `200` mesmo sem reservas) |
| DELETE | `/orcamentos/{numeroOS}` (Billing) | `billing.cancelar-orcamento` — cancela orcamento pendente/aprovado nao cobrado | `{ motivo }` | `200 { numeroOS, orcamentoId, estornado: false }` ≙ `billing.orcamento-cancelado` (idempotente) |
| POST | `/orcamentos/{numeroOS}/cobrar` (Billing) | reprocessar em `COBRAR`/`AGUARDAR_PAGAMENTO` (nova cobranca) | — | `201` ≙ `billing.cobranca-criada` |

Mesmo cliente HTTP do kit (JWT `SERVICO`, 3 tentativas, correlacao). Retry esgotado: a compensacao fica `enviadaEm` sem `confirmadaEm`, a saga em `COMPENSANDO`, o gauge `oficina_os_sagas_paradas` sobe e `reprocessar` reenvia.

## O que salva no banco

Postgres **`oficina_os`**:

| Tabela | O que esta story grava |
|---|---|
| `saga_os` | `status = COMPENSANDO` -> `CANCELADA`; `compensacoes` (JSON: comando, `enviadaEm`, `confirmadaEm`, tentativas); `falha_simulada`; historico com `compensacao`, `reprocessada`, `falha-simulada`, `pagamento-pendente` |
| `ordem_de_servico` | `status = CANCELADA` + `motivo_cancelamento` (`EXECUCAO_RECUSADA`, `ORCAMENTO_REJEITADO`, `TIMEOUT_APROVACAO`, `FALHA_INICIO_EXECUCAO`, `OPERADOR`); pagamento recusado nao altera (`AGUARDANDO_PAGAMENTO`) |
| `ordem_de_servico_audit_log` | linha do cancelamento com o motivo |

Nos participantes: Execucao marca `EXECUCAO#<n> META.status = CANCELADA` e grava `ESTOQUE#<p> MOV#` de liberacao; Billing marca `orcamento.status = CANCELADO` e lanca `ORCAMENTO_CANCELADO` no `ledger`.

## Dependencias

- [US-F4-10](f4-10-saga-orquestrada.md)

## Matriz passo -> falha -> compensacao (implementada)

| Passo da saga | Falha (evento) | Compensacoes (chamadas HTTP, ordem de envio) | Motivo na OS |
|---|---|---|---|
| ENFILEIRAR_EXECUCAO | `execucao.recusada` (`409` em `POST /execucao/ordens`) | — | `EXECUCAO_RECUSADA` |
| AGUARDAR_APROVACAO | `billing.orcamento-rejeitado` (callback) | `execucao.liberar-reservas` = `DELETE /execucao/ordens/{n}` | `ORCAMENTO_REJEITADO` |
| AGUARDAR_APROVACAO | `saga.timeout` | `billing.cancelar-orcamento` = `DELETE /orcamentos/{n}`, `execucao.liberar-reservas` = `DELETE /execucao/ordens/{n}` | `TIMEOUT_APROVACAO` |
| INICIAR_EXECUCAO | `execucao.recusada` (`409` em `POST /execucao/ordens/{n}/iniciar`; aprovado, nao pago, nao executado) | `DELETE /orcamentos/{n}`, `DELETE /execucao/ordens/{n}` (sem estorno) | `FALHA_INICIO_EXECUCAO` |
| qualquer ate INICIAR_EXECUCAO | `POST :id/cancelar` (atendente) | conforme o passo: `DELETE /execucao/ordens/{n}` desde o 1o passo; `DELETE /orcamentos/{n}` a partir de GERAR_ORCAMENTO | `OPERADOR` |
| AGUARDAR_PAGAMENTO (apos a execucao) | `billing.pagamento-recusado` (callback) / prazo de pagamento vencido | **nenhuma** — pendencia: OS fica `AGUARDANDO_PAGAMENTO`, historico `pagamento-pendente` / `pagamento em atraso`, alerta `oficina_os_sagas_paradas`; `reprocessar` repete `POST /orcamentos/{n}/cobrar` | — (OS nao e cancelada) |

A partir de `AGUARDAR_FINALIZACAO` nao ha cancelamento (manual ou por compensacao): o servico esta sendo ou ja foi
executado. `PAGAMENTO_RECUSADO` e `TIMEOUT_PAGAMENTO` continuam no enum `MotivoCancelamento` por compatibilidade com
dados antigos, mas sao **reservados/obsoletos** — a saga nao os usa mais (decisao de 03/11/2026, ADR-0012).

Falha de **plataforma** (servico fora, timeout de rede, `5xx`, banco) nunca compensa: retry
com backoff no cliente HTTP (3 tentativas) -> retry esgotado -> saga fica no passo -> alerta de
saga parada -> `POST /admin/sagas/:numero/reprocessar` (runbook
[`saga-reprocessar.md`](../runbooks/saga-reprocessar.md)). Recuperacao para frente, sem DLQ.

## Notas de implementacao (03/11)

- `SagaOS.simularFalha(evento)`: troca o evento de sucesso pelo de falha uma unica vez no passo
  marcado em `falhaSimulada` (coluna `saga_os.falha_simulada`); registrado no historico como
  `falha-simulada`. O orquestrador aplica antes de `aplicar()`.
- `SagaOS.reprocessar({ itens })`: comandos reenviados ficam no historico como `reprocessada`;
  `billing.gerar-orcamento` e remontado a partir do snapshot da OS (`Item` do AsyncAPI). Com a
  RFC-0008 o reenvio e a repeticao da chamada HTTP do passo (US-F4-18).
- A rota `/admin/sagas` precisa estar no prefixo do OS Service no gateway (`var.services.os.prefixes`
  no infra-k8s) — hoje nao esta; adicionar `/admin` quando o deploy voltar (rota protegida por JWT ADMIN).
- Demo: `SAGA_SIMULAR_FALHA_HABILITADO=true` no overlay `k8s-aws` e no `.env.example`; em qualquer
  ambiente real a flag deve ficar ausente.
