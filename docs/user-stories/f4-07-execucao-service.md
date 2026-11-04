# US-F4-07: Execucao Service — Fila de Execucao, Diagnostico, Catalogo e Estoque em DynamoDB

**User Story:** Como Mecanico, quero uma fila de execucao com diagnostico, itens do catalogo e reserva de pecas num servico proprio, para trabalhar a OS do chao de oficina e comunicar a finalizacao sem depender do atendimento.

**Prioridade:** Alta
**Story Points:** 13
**Status:** To Do
**DDD Domain:** Execucao (novo) + Catalogo + Estoque
**DDD Layer:** Domain + Application + Infrastructure
**Repositorio:** novo — `soat-fiap-oficina-execucao-service`
**Revisao 03/11/2026:** transporte HTTP ([RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md), contrato em [`docs/contratos/http-interno.md`](../contratos/http-interno.md)) — codigo do OS Service sera refatorado na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)

## Contexto

Enunciado: "gerenciar a fila de execucao da OS; atualizar status durante
diagnostico e reparos; comunicar finalizacao ao OS Service". Catalogo e
Estoque vem junto porque e o mecanico quem adiciona servicos/pecas e reserva
estoque durante o diagnostico. Banco **NoSQL (DynamoDB)**: a "execucao de uma
OS" e um documento com timeline; o estoque usa *conditional writes*.

Desde 03/11 (RFC-0008) a Execucao e uma **API REST comum**: os comandos do
orquestrador chegam como endpoints HTTP (JWT `SERVICO`) e as acoes do mecanico
geram **callbacks** `POST /ordens-servico/{numeroOS}/eventos` no OS Service.
Sem fila, sem outbox, sem LocalStack.

## Criterios de Aceite

- [ ] Modelo single-table: `EXECUCAO#<os>` (status da fila, mecanico, itens, timeline), `SERVICO#`/`PRODUTO#` (catalogo com preco), `ESTOQUE#<produto>` (saldo, reservas)
- [ ] `POST /execucao/ordens` (SERVICO; ≙ `execucao.enfileirar`) -> cria item na fila -> `201 { numeroOS, posicaoFila }` (≙ `execucao.enfileirada`); veiculo ja em execucao -> `409 { motivo }` (≙ `execucao.recusada`); idempotente por `numeroOS`
- [ ] `POST /execucao/ordens/{numeroOS}/diagnostico` (MECANICO): grava mecanico, diagnostico e itens do catalogo (servicos/produtos) com **reserva de estoque** condicional `saldo - reservado >= qtd` e **precos congelados** -> callback `execucao.diagnostico-concluido` `{ numeroOS, mecanicoId, diagnostico, itens[] }` (`Item.servicoId` nos PRODUTOs). Rotas auxiliares da UI do mecanico (`atribuir`, `itens` incrementais) sao opcionais; o que vale para a saga e o callback
- [ ] `POST /execucao/ordens/{numeroOS}/iniciar` (SERVICO; ≙ `execucao.iniciar`) -> baixa efetiva do estoque -> `200 { numeroOS }` (≙ `execucao.iniciada`); estoque insuficiente -> `409 { motivo }`; `DELETE /execucao/ordens/{numeroOS}` (SERVICO; ≙ `execucao.liberar-reservas`) -> tira da fila, aborta diagnostico, devolve reservas -> `200 { numeroOS }` (≙ `execucao.reservas-liberadas`; idempotente, `200` mesmo sem reservas)
- [ ] `POST /execucao/ordens/{numeroOS}/finalizar` (MECANICO) -> callback `execucao.finalizada` `{ numeroOS, finalizadaEm }`; opcionalmente `POST /execucao/ordens/{numeroOS}/servicos/:id/concluir` e o ultimo servico concluido dispara o mesmo callback (policy da Fase 1)
- [ ] CRUD de catalogo (`/catalogo/servicos`, `/catalogo/produtos`) e estoque (`/estoque/movimentacoes`, alerta de estoque baixo) com roles GESTOR/ESTOQUISTA
- [ ] Callbacks ao OS Service via cliente HTTP do kit (`@guilhermeqmaia/oficina-kit/http`): JWT `SERVICO`, 3 tentativas com backoff, `x-correlation-id`/`traceparent`; `409` do OS -> reler e repetir; sem outbox/Streams/SNS
- [ ] Testes unitarios >= 80% (dominio puro) + integracao com DynamoDB Local; Swagger
## APIs que expoe

Conforme [`http-interno.md`](../contratos/http-interno.md). Prefixos `/execucao|/catalogo|/estoque` ficam atras do API Gateway (usuarios); as rotas `SERVICO` sao chamadas pelo OS Service direto pelo DNS interno (`http://execucao-service:3002`).

| Metodo | Rota | Role | Corpo | Resposta |
|---|---|---|---|---|
| POST | `/execucao/ordens` | SERVICO | `{ numeroOS, veiculoId, descricaoProblema }` | `201 { numeroOS, posicaoFila }` ≙ `execucao.enfileirada` · `409 { motivo }` ≙ `execucao.recusada` (veiculo ja em execucao) |
| POST | `/execucao/ordens/{numeroOS}/iniciar` | SERVICO | — | `200 { numeroOS }` ≙ `execucao.iniciada` (baixa efetiva do estoque) · `409 { motivo }` ≙ `execucao.recusada` (estoque insuficiente) |
| DELETE | `/execucao/ordens/{numeroOS}` | SERVICO | `{ motivo }` | `200 { numeroOS }` ≙ `execucao.reservas-liberadas` (idempotente) |
| POST | `/execucao/ordens/{numeroOS}/diagnostico` | MECANICO | `{ diagnostico, itens[] }` (`Item`: `tipo`, `referenciaId`, `quantidade`; `servicoId` nos PRODUTOs) | `200` execucao com itens/precos congelados e reservas; dispara callback `execucao.diagnostico-concluido` |
| POST | `/execucao/ordens/{numeroOS}/finalizar` | MECANICO | — | `200`; dispara callback `execucao.finalizada` |
| GET | `/execucao/ordens` · `/execucao/ordens/{numeroOS}` | MECANICO, ATENDENTE, ADMIN | — | `200` fila / execucao com timeline |
| GET/POST/PATCH/DELETE | `/catalogo/servicos*`, `/catalogo/produtos*` | GESTOR, ADMIN (leitura: MECANICO, ATENDENTE) | servico/produto com preco | CRUD |
| GET/POST | `/estoque` · `/estoque/movimentacoes` | ESTOQUISTA, GESTOR, ADMIN | `{ produtoId, tipo, quantidade, motivo }` | saldos, reservas, alerta de estoque baixo |
| GET | `/health` · `/metrics` · `/api` (Swagger) | interno | — | kit |

## APIs que consome

| Metodo | Rota (servico) | Quando | Corpo (envelope) | Resposta |
|---|---|---|---|---|
| POST | `/ordens-servico/{numeroOS}/eventos` (OS Service, `http://os-service:3000`) | mecanico conclui o diagnostico | `type: execucao.diagnostico-concluido`, `data: { numeroOS, mecanicoId, diagnostico, itens[] }` | `200 { aplicado, passo, status }` · `409` reler/repetir · `404` OS desconhecida |
| POST | `/ordens-servico/{numeroOS}/eventos` (OS Service) | mecanico finaliza | `type: execucao.finalizada`, `data: { numeroOS, finalizadaEm }` | idem |

JWT `SERVICO` (`sub: execucao-service`) emitido localmente com `mintServiceToken`; 3 tentativas com backoff; `x-correlation-id` = `numeroOS`. Nao chama o Billing nem a Lambda.

## O que salva no banco

DynamoDB **`oficina-execucao`** (single-table; tabela e IAM proprios — nenhum outro servico acessa):

| PK | SK | Item |
|---|---|---|
| `EXECUCAO#<numeroOS>` | `META` | status da fila (`ENFILEIRADA`, `EM_DIAGNOSTICO`, `DIAGNOSTICADA`, `EM_EXECUCAO`, `FINALIZADA`, `CANCELADA`), `veiculoId`, `mecanicoId`, `descricaoProblema`, `diagnostico`, `posicaoFila`, timestamps |
| `EXECUCAO#<numeroOS>` | `ITEM#<n>` | item do diagnostico: `tipo`, `referenciaId`, `nome`, `quantidade`, `precoUnitario` (congelado), `servicoId`, `concluido` |
| `EXECUCAO#<numeroOS>` | `EVENTO#<timestamp>` | timeline (enfileirada, diagnostico, iniciada, servico concluido, finalizada, reservas liberadas) |
| `SERVICO#<id>` / `PRODUTO#<id>` | `META` | catalogo com preco vigente, ativo/inativo |
| `ESTOQUE#<produtoId>` | `META` | `saldo`, `reservado`, `minimo` (conditional writes `saldo - reservado >= qtd`) |
| `ESTOQUE#<produtoId>` | `MOV#<timestamp>` | movimentacao (entrada, reserva, baixa, liberacao) com `numeroOS` quando houver |

GSI por `veiculoId` (recusa de veiculo ja em execucao) e por status da fila. **Sem itens `MSG#`** (nao ha outbox nem dedup de fila; a idempotencia dos comandos e por `numeroOS` no proprio `META`).

## Dependencias

- [US-F4-01](f4-01-kit-compartilhado.md), [US-F4-18](f4-18-comunicacao-http-entre-servicos.md) (kit `/http`, `Role.SERVICO`), [US-F4-03](f4-03-bancos-por-servico.md), [US-F4-DOC-03](f4-doc-03-contratos-eventos.md)
