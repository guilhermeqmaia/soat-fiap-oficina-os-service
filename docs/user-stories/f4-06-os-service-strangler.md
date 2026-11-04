# US-F4-06: OS Service — Evolucao do Monolito (Strangler) e Publicacao de Eventos

**User Story:** Como Atendente, quero abrir e acompanhar ordens de servico num servico dedicado que publica eventos confiaveis, para que diagnostico, orcamento e execucao aconteçam em outros servicos sem que a OS perca consistencia.

**Prioridade:** Alta
**Story Points:** 8
**Status:** Em andamento — concluída — PR 1 (domínio/API/banco, #87), PR 2 (outbox + consumidores SQS, #88) e PR 3 (NodePort 30080, SNS/SQS no deploy, rename do repo). Pendência fora desta story: UIs apontarem para Execução/Billing (US-F4-07/08). QA: [QA_PLAN_US-F4-06](../qa-plans/QA_PLAN_US-F4-06.md)
**DDD Domain:** Atendimento (OrdemDeServico, Cliente, Veiculo) + Notificacao
**DDD Layer:** Domain + Application + Infrastructure
**Repositorio:** `soat-fiap-oficina-os-service` -> OS Service
**Revisao 03/11/2026:** transporte HTTP ([RFC-0008](../arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md), contrato em [`docs/contratos/http-interno.md`](../contratos/http-interno.md)) — codigo do OS Service sera refatorado na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)

## Contexto

Estrategia *strangler*: o monolito da Fase 3 ja e, em essencia, o OS Service.
Removem-se Catalogo, Estoque e a execucao (vao para a Execucao); orcamento e
pagamento vao para o Billing. A OS guarda um **snapshot** dos itens (nome,
quantidade, preco) que chega pelos eventos — nunca consulta o catalogo de outro
servico. `@OnEvent` in-process virou publicacao via outbox (ADR-0001 previu isso) e, desde
03/11 (RFC-0008), vira **chamadas HTTP** ao Billing/Execucao e **callbacks** recebidos em
`POST /ordens-servico/{numero}/eventos`; a Notificacao continua in-process.

## Criterios de Aceite

- [x] Modulos `produto`, `servico` e casos de uso de execucao/orcamento removidos; `architecture.spec.ts` atualizado
- [x] OS mantem Cliente, Veiculo, historico/auditoria de status, consulta por CPF (posse via claim) e tempo medio por status (metrica Prometheus `oficina_os_tempo_no_status_seconds`; o tempo medio de *execucao* por servico vai com a Execucao)
- [x] Novo status **`AGUARDANDO_PAGAMENTO`** (entre `EM_EXECUCAO` e `FINALIZADA` desde 03/11 — cobranca apos a execucao, ADR-0012); maquina de estados atualizada e testada (+ `motivoCancelamento` para as compensacoes)
- [x] ~~Publica via **outbox**: `os.aberta`, `os.cancelada`, `os.finalizada`, `os.entregue`~~ → **revisao 03/11:** chama Execucao/Billing por HTTP e recebe callbacks em `POST /ordens-servico/{numero}/eventos`; eventos `os.*` deixam de ser publicados (a Notificacao e in-process) — refatoracao na [US-F4-18](f4-18-comunicacao-http-entre-servicos.md)
- [x] Consome: `execucao.diagnostico-concluido` (grava snapshot dos itens), `billing.orcamento-gerado`, `billing.pagamento-aprovado`, `execucao.finalizada` — consumidores idempotentes (fila `os-eventos.fifo`, 13 handlers em `infrastructure/messaging/` (inclui `billing.cobranca-criada`), dedup em `processed_messages`). **Revisao 03/11:** os mesmos `type`s passam a chegar pelo callback HTTP (um unico controller no lugar dos handlers SQS); a dedup por `id` em `processed_messages` continua
- [x] Endpoints de mutacao removidos: adicionar servico/produto, aprovar/rejeitar, iniciar/concluir servico (agora nos outros servicos) — Swagger atualizado; novo `POST /ordens-servico/:id/cancelar`
- [ ] UIs `admin`/`cliente` apontam para os novos servicos *(depende dos endpoints da Execucao/Billing — US-F4-07/08)*
- [x] Notificacao ao cliente continua aqui, alimentada pelos eventos in-process (`OsStatusAlteradoEvent`, `OrcamentoProntoEvent`, `OsFinalizadaEvent`); links e consumo de `billing.*` na [US-F4-12](f4-12-notificacoes-por-eventos.md)
- [x] Usa o kit ([US-F4-01](f4-01-kit-compartilhado.md)) 0.2.1; cobertura 94%; repositorio renomeado para `soat-fiap-oficina-os-service` (GitHub redireciona o nome antigo; trust OIDC do `github-actions-oficina` estendida ao novo nome; imagem ECR continua `oficina-mecanica-app`)
## APIs que expoe

Rotas atuais do OS Service (todas atras do API Gateway, prefixos `/ordens-servico|/clientes|/veiculos|/usuario|/notificacoes|/auth/me|/admin`) mais o callback interno:

| Metodo | Rota | Role | Corpo | Resposta |
|---|---|---|---|---|
| POST | `/ordens-servico` | ADMIN, ATENDENTE | `{ clienteId, veiculoId, descricaoInicial }` (header opcional `x-simular-falha`) | `201` OS `RECEBIDA` (dispara `POST /execucao/ordens`) |
| GET | `/ordens-servico` | ADMIN, ATENDENTE, MECANICO | — | `200` lista ordenada por status/prazo |
| GET | `/ordens-servico/:id` | ADMIN, ATENDENTE, MECANICO | — | `200` OS com snapshot dos itens |
| GET | `/ordens-servico/numero/:numero/status` | publico | — | `200 { numero, status }` |
| GET | `/ordens-servico/numero/:numero/saga` | ADMIN, ATENDENTE, MECANICO | — | `200` linha do tempo da saga |
| GET | `/ordens-servico/:id/audit-log` | ADMIN, ATENDENTE | — | `200` historico |
| POST | `/ordens-servico/:id/cancelar` | ADMIN, ATENDENTE | `{ motivo: "OPERADOR" }` | `201` OS `CANCELADA` (compensacoes por HTTP) / `400` |
| POST | `/ordens-servico/:id/entregar` | ADMIN, ATENDENTE | — | `201` OS `ENTREGUE` |
| DELETE | `/ordens-servico/:id` | ADMIN | — | `204` |
| **POST** | **`/ordens-servico/{numero}/eventos`** | **SERVICO** (callback) | envelope `{ id, type, version, occurredAt, producer, data }` | `200 { aplicado, duplicado?, passo, status }` / `404` OS inexistente / `409` conflito (repetir) |
| GET | `/clientes/:cpfCnpj/ordens-servico` | CLIENTE (posse via claim) | — | `200` OS do cliente |
| GET | `/clientes/:cpfCnpj/notificacoes` | CLIENTE | — | `200` (US-F4-12) |
| POST/GET/PATCH/DELETE | `/clientes*`, `/veiculos*`, `/usuario*` | ADMIN/ATENDENTE/MECANICO conforme a Fase 1 | CRUD | CRUD |
| GET | `/auth/me` | qualquer autenticado | — | `200` claims |
| POST | `/admin/sagas/:numero/reprocessar` | ADMIN | — | `200 { reenviados, saga }` (US-F4-11) |

## APIs que consome

Chamadas internas pelo DNS do cluster (nao passam pelo gateway), JWT `role: SERVICO` (`sub: os-service`), timeout 5 s, 3 tentativas com backoff; cabecalhos `x-correlation-id` = numero da OS e `traceparent`:

| Metodo | Rota (servico) | Quando | Corpo | Resposta = evento |
|---|---|---|---|---|
| POST | `/execucao/ordens` (Execucao) | ao abrir a OS | `{ numeroOS, veiculoId, descricaoProblema }` | `201 { numeroOS, posicaoFila }` ≙ `execucao.enfileirada`; `409 { motivo }` ≙ `execucao.recusada` |
| POST | `/execucao/ordens/{numeroOS}/iniciar` (Execucao) | apos `billing.orcamento-aprovado` | — | `200 { numeroOS }` ≙ `execucao.iniciada`; `409` ≙ `execucao.recusada` |
| DELETE | `/execucao/ordens/{numeroOS}` (Execucao) | compensacao | `{ motivo }` | `200 { numeroOS }` ≙ `execucao.reservas-liberadas` |
| POST | `/orcamentos` (Billing) | apos `execucao.diagnostico-concluido` | `{ numeroOS, clienteId, itens[] }` | `201 { numeroOS, orcamentoId, total, validoAte }` ≙ `billing.orcamento-gerado` |
| POST | `/orcamentos/{numeroOS}/cobrar` (Billing) | apos `execucao.finalizada` | — | `201 { numeroOS, orderId, linkPagamento, valor }` ≙ `billing.cobranca-criada` |
| DELETE | `/orcamentos/{numeroOS}` (Billing) | compensacao | `{ motivo }` | `200 { numeroOS, orcamentoId, estornado }` ≙ `billing.orcamento-cancelado` |

Nao chama a Lambda de auth (valida o JWT localmente com o mesmo `JWT_SECRET`). Callbacks que recebe: `execucao.diagnostico-concluido`, `execucao.finalizada`, `billing.orcamento-aprovado`, `billing.orcamento-rejeitado`, `billing.pagamento-aprovado`, `billing.pagamento-recusado`.

## O que salva no banco

Postgres **`oficina_os`** (usuario exclusivo; nenhum outro servico acessa):

| Tabela | O que guarda |
|---|---|
| `cliente`, `veiculo` | cadastro do atendimento (CPF/CNPJ validado no dominio; placa) |
| `ordem_de_servico` | numero, cliente, veiculo, descricao, status (`RECEBIDA`..`ENTREGUE`/`CANCELADA`), `motivo_cancelamento`, `version` (lock otimista), timestamps por status |
| `item_ordem_de_servico_servico`, `item_ordem_de_servico_produto` | **snapshot** dos itens recebido em `execucao.diagnostico-concluido` (nome, quantidade, preco unitario congelado, `servicoId` do produto) — nunca consulta o catalogo da Execucao |
| `saga_os` | passo, status, historico, compensacoes, prazos, `falha_simulada`, `version` (US-F4-10/11) |
| `ordem_de_servico_audit_log` | uma linha por mudanca de status/acao (quem, quando, metadata) |
| `notificacao` | notificacoes enviadas ao cliente (canal, payload, status) — US-F4-12 |
| `processed_messages` | `id` dos envelopes recebidos em `POST /ordens-servico/{numero}/eventos` (dedup de callbacks; purga 7 dias) |
| `usuario` | staff local (legado da Fase 1; auth e da Lambda) |

Sai (US-F4-18): `outbox`. Nao guarda nada de orcamento, cobranca, catalogo ou estoque.

## Dependencias

- [US-F4-01](f4-01-kit-compartilhado.md), [US-F4-03](f4-03-bancos-por-servico.md); transporte HTTP: [US-F4-18](f4-18-comunicacao-http-entre-servicos.md) (substitui a dependencia da US-F4-02, cancelada)

## Review e ajustes (20/10)

Revisao independente dos PRs #87–#89 gerou um lote de correcoes (PR de review):

- **Contrato:** `Item.servicoId` (opcional) entrou no AsyncAPI — a Execucao deve preenche-lo nos
  PRODUTOs para o snapshot agrupar as pecas sob o servico; `diagnostico` limitado a 5..1000 chars.
- **Migration:** backfill do `nome` dos itens a partir de `servico`/`produto` **antes** do drop.
- **Lock otimista** (`ordem_de_servico.version`): cancelar/entregar por HTTP e transicoes por evento
  concorrem pela mesma OS; conflito devolve 409 (HTTP) ou falha o handler (retry -> DLQ).
- **Notificacao:** e-mail de orcamento sem links para rotas removidas; `WEBHOOK_APPROVAL_TOKEN` apagado.
- `causationId` nos eventos `os.*` gerados a partir de eventos consumidos; audit log do diagnostico;
  purga de `outbox`/`processed_messages` (7 dias); LocalStack usa `scripts/messaging-local.sh`
  (copia do kit); CI valida o overlay `k8s-aws`.

### Runbook — dados da Fase 3 no RDS (executar ANTES do primeiro deploy do OS Service)

Catalogo e estoque **nao migram** automaticamente (tabelas sao removidas): exportar antes
(`pg_dump -t servico -t produto`) se a Execucao (US-F4-07) quiser semear o DynamoDB com eles.
OS em voo nao tem contraparte no Billing/Execucao e precisam de decisao manual:

```sql
-- antes da migration: OS que ainda nao estavam em execucao -> cancelar (cliente reabre na Fase 4)
UPDATE ordem_de_servico SET status = 'CANCELADA', updated_at = now()
 WHERE status IN ('RECEBIDA','EM_DIAGNOSTICO','AGUARDANDO_APROVACAO');
-- OS em execucao: concluir na oficina e marcar FINALIZADA (entrega continua pela API)
UPDATE ordem_de_servico SET status = 'FINALIZADA', updated_at = now() WHERE status = 'EM_EXECUCAO';
-- depois da migration: registrar o motivo nas canceladas acima
UPDATE ordem_de_servico SET motivo_cancelamento = 'OPERADOR' WHERE status = 'CANCELADA' AND motivo_cancelamento IS NULL;
```

No ambiente de demonstracao o banco e recriado pelos seeds; o runbook existe para um RDS com historico real.
