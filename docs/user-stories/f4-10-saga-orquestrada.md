# US-F4-10: Saga Orquestrada da Ordem de Servico

**User Story:** Como Sistema, quero coordenar abrir OS -> diagnostico -> orcamento -> aprovacao/pagamento -> execucao -> finalizacao como uma saga com estado explicito, para que a OS avance entre tres servicos e tres bancos de forma consistente e rastreavel.

**Prioridade:** Alta
**Story Points:** 13
**Status:** Em revisão — implementada no OS Service (PR da US-F4-10). QA: [QA_PLAN_US-F4-10](../qa-plans/QA_PLAN_US-F4-10.md)
**DDD Domain:** Atendimento (orquestracao do ciclo de vida da OS)
**DDD Layer:** Application (orquestrador) + Infrastructure (cliente HTTP interno e callback)
**Repositorio:** OS Service
**Revisao 03/11/2026:** transporte HTTP ([RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md), contrato em [`docs/contratos/http-interno.md`](../contratos/http-interno.md)) — codigo do OS Service sera refatorado na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)

## Contexto

Decisao (RFC-0005): **saga orquestrada**, com o orquestrador dentro do OS
Service — dono do ciclo de vida da OS, como o Gateway Core do iFood e uma
maquina de estados dos pedidos. O orquestrador envia **comandos** e reage a
**eventos**; o estado de cada saga e persistido e consultavel (isso e o que o
video precisa mostrar em "rastreamento dos fluxos distribuidos").

## Criterios de Aceite

- [x] Tabela `saga_os` (numero da OS, passo atual, status, historico de passos com timestamps, compensacoes executadas, `correlationId`) — `correlationId` = numero da OS (chave unica); lock otimista por `version`
- [x] Passos: `ENFILEIRAR_EXECUCAO` -> `AGUARDAR_DIAGNOSTICO` -> `GERAR_ORCAMENTO` -> `AGUARDAR_APROVACAO` -> `INICIAR_EXECUCAO` -> `AGUARDAR_FINALIZACAO` -> `COBRAR` -> `AGUARDAR_PAGAMENTO` -> `CONCLUIDA` (`saga/domain/saga-os.entity.ts`; cobranca apos a execucao desde 03/11 — ADR-0012)
- [x] Cada passo: comando enviado via outbox (mesma transacao da saga); transicao so ao receber o evento esperado; eventos fora de ordem/duplicados ignorados com log e registro no historico. **Revisao 03/11:** o comando vira **chamada HTTP com retry** (kit `/http`) feita apos o commit da saga; a resposta sincrona (`201`/`200`/`409`) e convertida no evento esperado e aplicada na mesma maquina de estados; os eventos que dependem de pessoa/Mercado Pago chegam por `POST /ordens-servico/{numero}/eventos` ([US-F4-18](f4-18-comunicacao-http-entre-servicos.md))
- [x] Transicoes da OS ligadas aos passos (`EM_DIAGNOSTICO`, `AGUARDANDO_APROVACAO`, `EM_EXECUCAO`, `AGUARDANDO_PAGAMENTO`, `FINALIZADA`) — a saga decide, os use cases de transicao da US-F4-06 aplicam; `billing.orcamento-aprovado` nao muda a OS (so dispara `execucao.iniciar`)
- [x] **Timeouts** (scheduler): `SagaTimeoutsService` varre prazos vencidos (`SAGA_TIMEOUT_APROVACAO_DIAS`=3, `SAGA_TIMEOUT_PAGAMENTO_HORAS`=24; overrides em ms para a demo) -> `saga.timeout` -> compensacao para a aprovacao ([US-F4-11](f4-11-compensacoes-rollback.md)); o prazo de pagamento (pos-execucao) so registra `pagamento em atraso` e alimenta o alerta — nao cancela
- [x] `GET /ordens-servico/numero/:numero/saga` devolve a linha do tempo (passos, eventos, compensacoes, prazos) — usado no video e no dashboard
- [x] Metricas: `oficina_os_saga_passos_total{passo,resultado}`, `oficina_os_saga_passo_duracao_seconds{passo}`, `oficina_os_sagas{status}` (inclui COMPENSANDO)
- [x] Testes unitarios do orquestrador como maquina de estados pura (`saga-os.entity.spec.ts`, `orquestrador-saga.service.spec.ts`) + e2e com os handlers SQS (caminho feliz, duplicado/fora de ordem, rejeicao, cancelamento manual, timeout). **Revisao 03/11:** os e2e passam a usar o endpoint de callback e Execucao/Billing mockados por HTTP (nock/msw) — US-F4-18
## APIs que expoe

| Metodo | Rota | Role | Corpo | Resposta |
|---|---|---|---|---|
| GET | `/ordens-servico/numero/:numero/saga` | ADMIN, ATENDENTE, MECANICO | — | `200 { numero, passo, status, passoDesde, prazos, historico[], compensacoes[] }` |
| POST | `/ordens-servico/{numero}/eventos` | SERVICO | envelope `{ id, type, version, occurredAt, producer, data }` com `type` em `execucao.diagnostico-concluido`, `execucao.finalizada`, `billing.orcamento-aprovado`, `billing.orcamento-rejeitado`, `billing.pagamento-aprovado`, `billing.pagamento-recusado` | `200 { aplicado, duplicado?, passo, status }` · `404` OS inexistente · `409` conflito de versao (repetir) |
| POST | `/ordens-servico` | ADMIN, ATENDENTE | abre a OS e inicia a saga (`ENFILEIRAR_EXECUCAO`) | `201` |

## APIs que consome

O orquestrador chama, por passo (JWT `SERVICO`, timeout 5 s, 3 tentativas com backoff 200 ms / 800 ms / 3 s so para `5xx`/timeout/rede):

| Passo | Metodo | Rota (servico) | Resposta esperada = evento |
|---|---|---|---|
| `ENFILEIRAR_EXECUCAO` | POST | `/execucao/ordens` (Execucao) | `201` ≙ `execucao.enfileirada` · `409` ≙ `execucao.recusada` |
| `GERAR_ORCAMENTO` | POST | `/orcamentos` (Billing) | `201`/`200` ≙ `billing.orcamento-gerado` |
| `INICIAR_EXECUCAO` | POST | `/execucao/ordens/{n}/iniciar` (Execucao) | `200` ≙ `execucao.iniciada` · `409` ≙ `execucao.recusada` |
| `COBRAR` | POST | `/orcamentos/{n}/cobrar` (Billing) | `201` ≙ `billing.cobranca-criada` |
| compensacao | DELETE | `/orcamentos/{n}` (Billing) · `/execucao/ordens/{n}` (Execucao) | `200` ≙ `billing.orcamento-cancelado` · `execucao.reservas-liberadas` |

Passos `AGUARDAR_DIAGNOSTICO`, `AGUARDAR_APROVACAO`, `AGUARDAR_FINALIZACAO`, `AGUARDAR_PAGAMENTO` nao chamam ninguem: esperam o callback.

## O que salva no banco

Postgres **`oficina_os`**, na mesma transacao da OS (`PrismaUnitOfWork`):

| Tabela | O que esta story grava |
|---|---|
| `saga_os` | `numero_os` (unique = `correlationId`), `passo`, `status` (`EM_ANDAMENTO`, `COMPENSANDO`, `CONCLUIDA`, `CANCELADA`), `passo_desde`, `prazo_aprovacao`/`prazo_pagamento`, `historico` (JSON: evento, passo, resultado, `reprocessada`, `falha-simulada`, `pagamento-pendente`), `compensacoes` (JSON: comando, `enviadaEm`, `confirmadaEm`), `falha_simulada`, `version` |
| `ordem_de_servico` | transicoes de status decididas pela saga (`EM_DIAGNOSTICO`, `AGUARDANDO_APROVACAO`, `EM_EXECUCAO`, `AGUARDANDO_PAGAMENTO`, `FINALIZADA`, `CANCELADA` + `motivo_cancelamento`), snapshot dos itens |
| `processed_messages` | `id` do envelope de cada callback aplicado (dedup; purga 7 dias) |
| `ordem_de_servico_audit_log` | uma linha por transicao |

Sai (US-F4-18): `outbox`. O estado dos participantes (orcamento, cobranca, fila, reservas) fica nos bancos deles.

## Dependencias

- [US-F4-06](f4-06-os-service-strangler.md), [US-F4-07](f4-07-execucao-service.md), [US-F4-08](f4-08-billing-orcamento.md), [US-F4-DOC-03](f4-doc-03-contratos-eventos.md)

## Notas de implementacao (21/10)

> Escritas para o transporte SQS/outbox. Com a RFC-0008 (03/11) `outbox`, `MessageGroupId` e
> `handlers da fila` sao substituidos por chamadas HTTP e pelo controller de callback na US-F4-18;
> a maquina de estados (`SagaOS`), a transacao unica e as regras abaixo continuam validas.

- **Onde:** `src/ordem-de-servico/saga/` — `domain/saga-os.entity.ts` (maquina de estados pura: recebe evento, devolve
  transicao da OS + comandos), `application/orquestrador-saga.service.ts` (persiste, aplica na OS, publica),
  `application/saga-timeouts.service.ts` (relogio), `infrastructure/prisma-saga.repository.ts` (`saga_os` + outbox na
  mesma transacao).
- **Entrada dos eventos:** todos os handlers da fila `os-eventos` entregam ao orquestrador; o cancelamento manual
  (`POST :id/cancelar`) tambem passa por ele (`os.cancelamento-manual`) e compensa conforme o passo.
- **Transacao unica (unit of work):** carrega saga -> aplica (decide) -> transiciona a OS -> salva saga + comandos, tudo
  no mesmo `$transaction` do Postgres (`PrismaUnitOfWork`). A abertura da OS tambem grava OS + `os.aberta` + saga +
  `execucao.enfileirar` juntos. Conflito de lock otimista: ate 3 tentativas em processo, depois 409/reentrega.
- **OS anterior a saga:** adotada no passo equivalente ao status (EM_DIAGNOSTICO com diagnostico gravado = GERAR_ORCAMENTO); em RECEBIDA reenvia `execucao.enfileirar`.
- **Cancelamento manual:** desde o primeiro passo a Execucao recebe `execucao.liberar-reservas` (o `enfileirar` ja saiu);
  comandos da mesma OS usam o mesmo MessageGroupId, entao o cancelamento nunca ultrapassa o comando anterior na fila.
  Apos `billing.orcamento-aprovado` (passo INICIAR_EXECUCAO) cancelar ainda e permitido (nada foi pago); a partir de AGUARDAR_FINALIZACAO e rejeitado.
- **Diagnostico sem itens** (viola o contrato): ignorado com registro; a saga espera um diagnostico valido.
- **Saga parada** (sem evento esperado num passo sem timeout): gauge `oficina_os_sagas_paradas` + warn; o reprocessamento e da US-F4-11.
- **Matriz de compensacao** (US-F4-11): enfileirar recusado -> nada; orcamento rejeitado -> `execucao.liberar-reservas`;
  timeout de aprovacao / cancelamento manual apos orcamento -> `billing.cancelar-orcamento` + `execucao.liberar-reservas`;
  `execucao.recusada` em `INICIAR_EXECUCAO` (aprovado, nao pago, nao executado) -> `billing.cancelar-orcamento` + liberar reservas (sem estorno).
  A saga fica `COMPENSANDO` ate `billing.orcamento-cancelado` / `execucao.reservas-liberadas` confirmarem; depois `CANCELADA`.
- **Cobranca apos a execucao (03/11):** `execucao.finalizada` -> OS `AGUARDANDO_PAGAMENTO` + comando `billing.cobrar` (passo `COBRAR`);
  `billing.cobranca-criada` -> `AGUARDAR_PAGAMENTO` (link ao cliente pela Notificacao; OS inalterada); `billing.pagamento-aprovado` -> `FINALIZADA` (`os.finalizada`).
  Pagamento recusado / em atraso nao compensa: historico `pagamento-pendente`, saga segue `EM_ANDAMENTO` em `AGUARDAR_PAGAMENTO`, `reprocessar` reenvia `billing.cobrar`.
- **Fora desta story:** `POST /admin/sagas/:os/reprocessar`, injecao de falhas e retries de comandos ficam na US-F4-11.
- **Review (21/10):** transacao unica, retry em conflito, `passoDesde`, teto do historico, DTO so aceita `OPERADOR`,
  deletar OS apaga a saga, historico do cliente inclui OS encerradas.
