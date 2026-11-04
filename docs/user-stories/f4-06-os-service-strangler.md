# US-F4-06: OS Service — Evolucao do Monolito (Strangler) e Publicacao de Eventos

**User Story:** Como Atendente, quero abrir e acompanhar ordens de servico num servico dedicado que publica eventos confiaveis, para que diagnostico, orcamento e execucao aconteçam em outros servicos sem que a OS perca consistencia.

**Prioridade:** Alta
**Story Points:** 8
**Status:** Em andamento — concluída — PR 1 (domínio/API/banco, #87), PR 2 (outbox + consumidores SQS, #88) e PR 3 (NodePort 30080, SNS/SQS no deploy, rename do repo). Pendência fora desta story: UIs apontarem para Execução/Billing (US-F4-07/08). QA: [QA_PLAN_US-F4-06](../qa-plans/QA_PLAN_US-F4-06.md)
**DDD Domain:** Atendimento (OrdemDeServico, Cliente, Veiculo) + Notificacao
**DDD Layer:** Domain + Application + Infrastructure
**Repositorio:** `soat-fiap-oficina-os-service` -> OS Service

## Contexto

Estrategia *strangler*: o monolito da Fase 3 ja e, em essencia, o OS Service.
Removem-se Catalogo, Estoque e a execucao (vao para a Execucao); orcamento e
pagamento vao para o Billing. A OS guarda um **snapshot** dos itens (nome,
quantidade, preco) que chega pelos eventos — nunca consulta o catalogo de outro
servico. `@OnEvent` in-process vira publicacao via outbox (ADR-0001 previu isso).

## Criterios de Aceite

- [x] Modulos `produto`, `servico` e casos de uso de execucao/orcamento removidos; `architecture.spec.ts` atualizado
- [x] OS mantem Cliente, Veiculo, historico/auditoria de status, consulta por CPF (posse via claim) e tempo medio por status (metrica Prometheus `oficina_os_tempo_no_status_seconds`; o tempo medio de *execucao* por servico vai com a Execucao)
- [x] Novo status **`AGUARDANDO_PAGAMENTO`** (entre `EM_EXECUCAO` e `FINALIZADA` desde 03/11 — cobranca apos a execucao, ADR-0012); maquina de estados atualizada e testada (+ `motivoCancelamento` para as compensacoes)
- [x] Publica via **outbox**: `os.aberta` (com veiculo/cliente resumidos), `os.cancelada`, `os.finalizada`, `os.entregue` (gravados na transacao da OS; `OutboxPoller` -> `oficina-os.fifo`)
- [x] Consome: `execucao.diagnostico-concluido` (grava snapshot dos itens), `billing.orcamento-gerado`, `billing.pagamento-aprovado`, `execucao.finalizada` — consumidores idempotentes (fila `os-eventos.fifo`, 13 handlers em `infrastructure/messaging/` (inclui `billing.cobranca-criada`), dedup em `processed_messages`; `pagamento-aprovado`/`orcamento-cancelado`/`reservas-liberadas` so logam ate o orquestrador da US-F4-10)
- [x] Endpoints de mutacao removidos: adicionar servico/produto, aprovar/rejeitar, iniciar/concluir servico (agora nos outros servicos) — Swagger atualizado; novo `POST /ordens-servico/:id/cancelar`
- [ ] UIs `admin`/`cliente` apontam para os novos servicos *(depende dos endpoints da Execucao/Billing — US-F4-07/08)*
- [x] Notificacao ao cliente continua aqui, alimentada pelos eventos in-process (`OsStatusAlteradoEvent`, `OrcamentoProntoEvent`, `OsFinalizadaEvent`); links e consumo de `billing.*` na [US-F4-12](f4-12-notificacoes-por-eventos.md)
- [x] Usa o kit ([US-F4-01](f4-01-kit-compartilhado.md)) 0.2.1; cobertura 94%; repositorio renomeado para `soat-fiap-oficina-os-service` (GitHub redireciona o nome antigo; trust OIDC do `github-actions-oficina` estendida ao novo nome; imagem ECR continua `oficina-mecanica-app`)
## Dependencias

- [US-F4-01](f4-01-kit-compartilhado.md), [US-F4-02](f4-02-mensageria.md), [US-F4-03](f4-03-bancos-por-servico.md)

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
