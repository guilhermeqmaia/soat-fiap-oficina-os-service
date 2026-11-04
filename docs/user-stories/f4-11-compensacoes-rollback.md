# US-F4-11: Compensacoes e Rollback Seguro da Saga

**User Story:** Como Sistema, quero que qualquer falha em qualquer passo da saga dispare as compensacoes corretas (liberar reservas, cancelar orcamento, cancelar OS), para que nenhuma OS fique num estado inconsistente entre os servicos.

**Prioridade:** Alta
**Story Points:** 8
**Status:** Em revisão — implementada no OS Service (PR da US-F4-11). QA: [QA_PLAN_US-F4-11](../qa-plans/QA_PLAN_US-F4-11.md)
**DDD Domain:** Atendimento + Execucao + Billing
**DDD Layer:** Application
**Repositorio:** OS Service (orquestrador) + Execucao + Billing (acoes compensatorias)

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
- [x] Compensacoes enfileiradas em ordem inversa (executadas em paralelo pelos participantes, filas distintas) e registradas em `saga_os.compensacoes` com `enviadaEm`/`confirmadaEm`
- [x] Retry com backoff nos comandos (SQS visibility 30 s, `maxReceiveCount` 5 no infra-k8s) e **DLQ** com alarme `*-dlq-nao-vazia`; runbook [`docs/runbooks/saga-dlq-reprocessar.md`](../runbooks/saga-dlq-reprocessar.md) (triagem, redrive com `start-message-move-task`, nunca descartar)
- [x] Endpoint interno `POST /admin/sagas/:numero/reprocessar` (ADMIN): reenvia pelo outbox o comando do passo atual ou as compensacoes nao confirmadas; nao altera a OS
- [x] **Injecao de falhas para demo:** header `x-simular-falha=<passo>` no `POST /ordens-servico` (so com `SAGA_SIMULAR_FALHA_HABILITADO=true`): no passo marcado o evento de sucesso vira o de falha (`ENFILEIRAR_EXECUCAO`, `AGUARDAR_APROVACAO`, `INICIAR_EXECUCAO`; em `AGUARDAR_PAGAMENTO` demonstra o pagamento pendente pos-execucao); cartoes de teste do Mercado Pago cobrem a falha real de pagamento (`docs/mercado-pago-sandbox.md`)
- [x] Teste de integracao para cada linha da matriz (e2e `ordem-de-servico.e2e.spec.ts`, bloco "saga orquestrada": recusada, rejeitado, timeout de aprovacao, falha ao iniciar execucao, cancelamento manual por passo, pagamento recusado mantem `AGUARDANDO_PAGAMENTO` + reprocessar reenvia `billing.cobrar`, cancelamento rejeitado apos a execucao, injecao de falhas)
## Dependencias

- [US-F4-10](f4-10-saga-orquestrada.md)

## Matriz passo -> falha -> compensacao (implementada)

| Passo da saga | Falha (evento) | Comandos de compensacao (ordem de envio) | Motivo na OS |
|---|---|---|---|
| ENFILEIRAR_EXECUCAO | `execucao.recusada` | — | `EXECUCAO_RECUSADA` |
| AGUARDAR_APROVACAO | `billing.orcamento-rejeitado` | `execucao.liberar-reservas` | `ORCAMENTO_REJEITADO` |
| AGUARDAR_APROVACAO | `saga.timeout` | `billing.cancelar-orcamento`, `execucao.liberar-reservas` | `TIMEOUT_APROVACAO` |
| INICIAR_EXECUCAO | `execucao.recusada` (aprovado, nao pago, nao executado) | `billing.cancelar-orcamento`, `execucao.liberar-reservas` (sem estorno) | `FALHA_INICIO_EXECUCAO` |
| qualquer ate INICIAR_EXECUCAO | `POST :id/cancelar` (atendente) | conforme o passo: `execucao.liberar-reservas` desde o 1o passo; `billing.cancelar-orcamento` a partir de GERAR_ORCAMENTO | `OPERADOR` |
| AGUARDAR_PAGAMENTO (apos a execucao) | `billing.pagamento-recusado` / prazo de pagamento vencido | **nenhuma** — pendencia: OS fica `AGUARDANDO_PAGAMENTO`, historico `pagamento-pendente` / `pagamento em atraso`, alerta `oficina_os_sagas_paradas`; `reprocessar` reenvia `billing.cobrar` | — (OS nao e cancelada) |

A partir de `AGUARDAR_FINALIZACAO` nao ha cancelamento (manual ou por compensacao): o servico esta sendo ou ja foi
executado. `PAGAMENTO_RECUSADO` e `TIMEOUT_PAGAMENTO` continuam no enum `MotivoCancelamento` por compatibilidade com
dados antigos, mas sao **reservados/obsoletos** — a saga nao os usa mais (decisao de 03/11/2026, ADR-0012).

Falha de **plataforma** (servico fora, timeout de rede, banco) nunca compensa: retry pelo
SQS (5 tentativas) -> DLQ -> runbook. Recuperacao para frente.

## Notas de implementacao (03/11)

- `SagaOS.simularFalha(evento)`: troca o evento de sucesso pelo de falha uma unica vez no passo
  marcado em `falhaSimulada` (coluna `saga_os.falha_simulada`); registrado no historico como
  `falha-simulada`. O orquestrador aplica antes de `aplicar()`.
- `SagaOS.reprocessar({ itens })`: comandos reenviados ficam no historico como `reprocessada`;
  `billing.gerar-orcamento` e remontado a partir do snapshot da OS (`Item` do AsyncAPI).
- A rota `/admin/sagas` precisa estar no prefixo do OS Service no gateway (`var.services.os.prefixes`
  no infra-k8s) — hoje nao esta; adicionar `/admin` quando o deploy voltar (rota protegida por JWT ADMIN).
- Demo: `SAGA_SIMULAR_FALHA_HABILITADO=true` no overlay `k8s-aws` e no `.env.example`; em qualquer
  ambiente real a flag deve ficar ausente.
