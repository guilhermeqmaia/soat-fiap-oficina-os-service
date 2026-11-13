# QA Plan — US-F4-12: Notificacoes ao Cliente a partir dos Eventos

## Resumo
Valida que o cliente e notificado em cada marco da OS com os fatos que chegam pelos callbacks/respostas HTTP da saga (`billing.orcamento-gerado`, `billing.orcamento-aprovado`, `billing.cobranca-criada` com `linkPagamento`, `billing.pagamento-aprovado`, `billing.pagamento-recusado`) e pelas transicoes locais (`FINALIZADA`, `CANCELADA`), **sem duplicar** (uma notificacao por fato/tipo/canal) e **sem notificar o que nao aconteceu** (eventos so depois do commit; callback duplicado ou ignorado pela saga nao notifica). Cobre tambem o canal `WEBHOOK` gravado com o canal real, o payload `{ numeroOS, tipo, mensagem, linkPagamento? }` com HMAC e a compatibilidade de `GET /clientes/:cpfCnpj/notificacoes` e `GET /notificacoes`.

Tipos: `ORCAMENTO_PRONTO`, `ORCAMENTO_APROVADO`, `PAGAMENTO_PENDENTE`, `PAGAMENTO_APROVADO`, `PAGAMENTO_RECUSADO`, `OS_FINALIZADA`, `OS_CANCELADA` (e `STATUS_OS_ALTERADO` da Fase 2 para `EM_DIAGNOSTICO`/`EM_EXECUCAO`/`ENTREGUE`). Detalhes: `docs/notificacao-email.md`.

## Pre-requisitos
- Node 20+, Docker (Testcontainers / Postgres 16), `npm ci` e `npx prisma generate`
- Banco com a migration `20261110000000_notificacao_fatos_saga` aplicada (`npx prisma migrate deploy`)
- Para os testes manuais: OS Service rodando (`docker compose up -d` + `npm run start:dev`) e `npm run seed`
- Execucao e Billing reais **ou** mocks HTTP (WireMock/nock) respondendo como `docs/contratos/http-interno.md`; o `201` de `POST /orcamentos/{n}/cobrar` deve trazer `{ orderId, linkPagamento, valor }`
- Tokens: `mintToken` (ADMIN/ATENDENTE/CLIENTE com `cpf`) e `mintServiceToken({ servico: 'billing-service' | 'execucao-service' })` do kit `/testing`
- Canal e-mail: `NOTIFICATION_PROVIDER=email` (Ethereal sem credenciais — ver `preview=` no log) ou `mock`
- Canal webhook: `NOTIFICATION_PROVIDER=webhook`, `NOTIFICATION_WEBHOOK_URL=https://webhook.site/<token>`, `NOTIFICATION_WEBHOOK_SECRET=<segredo>`
- Cliente da OS com e-mail cadastrado (exceto TS-12)

## Cenarios de Teste

### TS-01: Orcamento pronto (resposta 201 de POST /orcamentos)
- **Tipo:** Ambos (unit do orquestrador e do listener, e2e, BDD `@caminho-feliz`)
- **Criterio:** Listener reage a `billing.orcamento-gerado`
- **Pre-condicao:** OS em `EM_DIAGNOSTICO`
- **Passos:**
  1. `POST /ordens-servico/{n}/eventos` (token Execucao) com `execucao.diagnostico-concluido` e itens validos
  2. O OS Service chama `POST /orcamentos`; o Billing responde `201 { orcamentoId, total }`
  3. `GET /notificacoes?ordemDeServicoId=<id>` (ATENDENTE)
- **Resultado esperado:** OS `AGUARDANDO_APROVACAO`; **uma** notificacao `ORCAMENTO_PRONTO` com diagnostico, total em BRL, `numeroOS` e `eventoId = billing.orcamento-gerado:<n>:<orcamentoId>`; **nenhuma** `STATUS_OS_ALTERADO` para `AGUARDANDO_APROVACAO`
- **Resultado alternativo:** Billing fora do ar (tentativas esgotadas) -> saga parada em `GERAR_ORCAMENTO`, sem notificacao

### TS-02: Orcamento aprovado (callback) — sem link
- **Tipo:** Ambos (unit, e2e, BDD)
- **Criterio:** Listener reage a `billing.orcamento-aprovado`; link so vem na cobranca
- **Pre-condicao:** OS em `AGUARDANDO_APROVACAO`
- **Passos:**
  1. Callback `billing.orcamento-aprovado` (token Billing)
  2. Consultar notificacoes da OS
- **Resultado esperado:** `ORCAMENTO_APROVADO` com `eventoId` = `id` do envelope, `linkPagamento = null`, mensagem dizendo que o link chega quando o servico terminar

### TS-03: Servico concluido -> PAGAMENTO_PENDENTE com link de pagamento
- **Tipo:** Ambos (unit do orquestrador/listener/use case, e2e, BDD)
- **Criterio:** Mensagens com o link de pagamento (`201` de `POST /orcamentos/{n}/cobrar`)
- **Pre-condicao:** OS em `EM_EXECUCAO`
- **Passos:**
  1. Callback `execucao.finalizada` (token Execucao)
  2. O OS Service chama `POST /orcamentos/{n}/cobrar`; o Billing responde `201 { orderId: "mp-1", linkPagamento: "https://...", valor: "300.00" }`
  3. Consultar `GET /notificacoes?ordemDeServicoId=<id>` e `GET /clientes/{cpf}/notificacoes` (token CLIENTE)
- **Resultado esperado:** OS `AGUARDANDO_PAGAMENTO`; `PAGAMENTO_PENDENTE` com `linkPagamento` igual ao do `201`, o link no texto da mensagem e `eventoId = billing.cobranca-criada:<n>:mp-1`; o cliente ve o mesmo `linkPagamento`; sem `STATUS_OS_ALTERADO` para `AGUARDANDO_PAGAMENTO`

### TS-04: Pagamento aprovado -> PAGAMENTO_APROVADO + OS_FINALIZADA
- **Tipo:** Ambos (e2e `callback billing.pagamento-aprovado gera ...`, BDD)
- **Criterio:** Listener reage a `billing.pagamento-aprovado` e a transicao `FINALIZADA`
- **Pre-condicao:** OS em `AGUARDANDO_PAGAMENTO`
- **Passos:**
  1. Callback `billing.pagamento-aprovado` `{ orderId, valor }`
  2. `GET /notificacoes?ordemDeServicoId=<id>`
- **Resultado esperado:** resposta `200 { aplicado: true }`; OS `FINALIZADA`; `PAGAMENTO_APROVADO` (`eventoId` = id do envelope) e `OS_FINALIZADA` (`eventoId = os.finalizada:<n>`), nessa ordem, ambas `ENVIADA`

### TS-05: Pagamento recusado -> PAGAMENTO_RECUSADO (sem rollback)
- **Tipo:** Ambos (unit, e2e, BDD `@pagamento`)
- **Criterio:** Listener reage a `billing.pagamento-recusado`
- **Pre-condicao:** OS em `AGUARDANDO_PAGAMENTO`
- **Passos:**
  1. Callback `billing.pagamento-recusado` `{ orderId, motivo: "cartao recusado" }`
  2. Consultar notificacoes; `POST /admin/sagas/{n}/reprocessar` (ADMIN); consultar de novo
- **Resultado esperado:** `PAGAMENTO_RECUSADO` com o motivo; OS segue `AGUARDANDO_PAGAMENTO`; apos reprocessar (nova cobranca, outro `orderId`) chega um **segundo** `PAGAMENTO_PENDENTE` com o link novo

### TS-06: Cancelamento -> OS_CANCELADA
- **Tipo:** Ambos (unit das transicoes, e2e, BDD `@compensacao`/`@cancelamento`)
- **Criterio:** Listener reage a transicao `CANCELADA`
- **Passos:**
  1. (a) OS `EM_DIAGNOSTICO`: `POST /ordens-servico/{id}/cancelar` (ATENDENTE); (b) OS `AGUARDANDO_APROVACAO`: callback `billing.orcamento-rejeitado`
  2. Consultar notificacoes
- **Resultado esperado:** uma `OS_CANCELADA` com o motivo (`OPERADOR` / `ORCAMENTO_REJEITADO`) e `eventoId = os.cancelada:<n>`; sem `STATUS_OS_ALTERADO` para `CANCELADA`

### TS-07: Canal WEBHOOK com HMAC e payload novo
- **Tipo:** Ambos (unit `webhook-notificador.adapter.spec.ts` + manual)
- **Criterio:** Canais mantidos: webhook (HMAC) e e-mail
- **Pre-condicao:** `NOTIFICATION_PROVIDER=webhook`, URL do webhook.site e segredo configurados
- **Passos:**
  1. Executar TS-03
  2. No webhook.site, abrir o POST recebido; recalcular `HMAC-SHA256(body, segredo)` (ex.: `printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SEGREDO"`)
  3. Consultar a notificacao em `GET /notificacoes`
- **Resultado esperado:** header `X-Signature: sha256=<hex>` igual ao calculado; body com `numeroOS`, `tipo: "PAGAMENTO_PENDENTE"`, `mensagem`, `linkPagamento` (+ campos da Fase 2); notificacao gravada com `canal: "WEBHOOK"` (nao `EMAIL`)
- **Resultado alternativo:** webhook responde 5xx -> 2 tentativas, notificacao `FALHOU` com o erro, fluxo da OS nao e afetado

### TS-08: Canal e-mail
- **Tipo:** Manual
- **Criterio:** Canais mantidos
- **Pre-condicao:** `NOTIFICATION_PROVIDER=email` (Ethereal ou Brevo)
- **Passos:** executar TS-01..TS-06 e abrir o `preview=` logado pelo `SmtpEmailNotificador`
- **Resultado esperado:** um e-mail por marco, assunto com o numero da OS, link de pagamento no e-mail do `PAGAMENTO_PENDENTE`; notificacoes com `canal: "EMAIL"`

### TS-09: Callback duplicado nao notifica de novo
- **Tipo:** Ambos (e2e, BDD `@idempotencia @notificacao`)
- **Criterio:** Idempotente — dedup em `processed_messages`
- **Passos:**
  1. OS `AGUARDANDO_PAGAMENTO`; enviar `billing.pagamento-aprovado`
  2. Reenviar o **mesmo** envelope (mesmo `id`)
  3. Repetir com outro `id` e o mesmo conteudo
- **Resultado esperado:** 2: `200 { aplicado: false, duplicado: true }`; 3: `200 { aplicado: false }` (saga ignora); em todos os casos continua **1** `PAGAMENTO_APROVADO` e **1** `OS_FINALIZADA`

### TS-10: Mesmo fato duas vezes no listener = um envio ("ja notificado")
- **Tipo:** Automatizado (unit `enviar-notificacao.use-case.spec.ts`, integracao `prisma-notificacao.repository.integration.spec.ts`)
- **Criterio:** Idempotente — uma notificacao por `id` do envelope
- **Passos:** executar o use case duas vezes com o mesmo `(eventoId, tipo)`; no Postgres, `create` duas vezes a mesma chave
- **Resultado esperado:** um unico envio; a segunda chamada loga `warn` "Ja notificado ..." e nao grava nem envia; no banco, o indice `notificacao_evento_id_tipo_canal_key` rejeita a segunda linha (`P2002`); outro tipo, outro canal ou outro evento nao conflitam; `evento_id` NULL nao deduplica

### TS-11: Regressao — nada e notificado de tentativa revertida
- **Tipo:** Automatizado (unit `orquestrador-saga.eventos-pos-commit.spec.ts`)
- **Criterio:** Idempotente — o evento so e emitido quando a saga avanca (e depois do commit)
- **Passos:** simular `ConcurrentModificationError` na 1a gravacao da saga durante `billing.pagamento-aprovado`; depois, 3 conflitos seguidos
- **Resultado esperado:** 1o caso: nenhum evento publicado dentro da transacao e exatamente uma mudanca de status `-> FINALIZADA` publicada (da tentativa que commitou); 2o caso: erro `409` e **nenhum** evento publicado

### TS-12: Cliente sem e-mail
- **Tipo:** Automatizado (unit do use case e do listener)
- **Criterio:** Canais mantidos
- **Passos:** marco para cliente com `email = null`, com notificador EMAIL e depois WEBHOOK
- **Resultado esperado:** EMAIL: nada gravado, `warn`; WEBHOOK: enviado com destinatario = id do cliente

### TS-13: Compatibilidade das consultas
- **Tipo:** Ambos (e2e + manual)
- **Criterio:** `GET /clientes/:cpf/notificacoes` inalterado
- **Passos:**
  1. `GET /clientes/{cpf}/notificacoes` com token CLIENTE do proprio CPF; com CPF de outro cliente
  2. `GET /notificacoes` com ADMIN, ATENDENTE e CLIENTE
  3. Conferir o Swagger (`/api`) do `NotificacaoResponseDto`
- **Resultado esperado:** mesmos codigos de antes (`200`/`403`); campos antigos intactos; `numeroOS`, `eventoId`, `linkPagamento` presentes e opcionais (null nas notificacoes antigas); enums `tipo`/`canal` com os valores novos no Swagger

## Edge Cases
- `201` do cobrar **sem** `linkPagamento`: notificacao `PAGAMENTO_PENDENTE` aponta para o portal; `linkPagamento` null
- `201` do cobrar sem `orderId`: `eventoId = billing.cobranca-criada:<n>` (uma segunda cobranca sem `orderId` nao gera nova notificacao)
- Callback fora de ordem (ex.: `billing.orcamento-aprovado` com a saga em `AGUARDAR_PAGAMENTO`): `aplicado: false`, sem notificacao
- Falha simulada (`x-simular-falha=AGUARDAR_PAGAMENTO`): pagamento aprovado vira recusado -> `PAGAMENTO_RECUSADO`, nunca `PAGAMENTO_APROVADO`
- Cancelamento apos a execucao (`AGUARDANDO_PAGAMENTO`): `400`, sem `OS_CANCELADA`
- Notificador lanca erro nao-`Error`: notificacao `FALHOU` com o texto
- Cliente inexistente no marco: nada enviado, `warn`
- Linhas da Fase 2 (sem `evento_id`) convivem com as novas; `numero_os` preenchido pelo backfill da migration

## Rastreabilidade

| Criterio de aceite | Cenarios |
|---|---|
| Listener reage a `billing.orcamento-gerado`, `-aprovado`, `cobranca-criada`, `pagamento-aprovado`, `pagamento-recusado` e as transicoes `FINALIZADA`/`CANCELADA`, sem fila | TS-01, TS-02, TS-03, TS-04, TS-05, TS-06 |
| Mensagens com o link de pagamento vindo do `201` do cobrar (nao no `orcamento-aprovado`) | TS-02, TS-03, TS-05 |
| Canais mantidos (webhook HMAC e e-mail); `GET /clientes/:cpf/notificacoes` inalterado | TS-07, TS-08, TS-12, TS-13 |
| Idempotente: uma notificacao por fato; callback repetido e retry sincrono nao notificam | TS-09, TS-10, TS-11 |

## Checklist de Validacao
- [x] Todos os criterios de aceite cobertos
- [x] Edge cases documentados
- [x] Fluxos de erro documentados (webhook 5xx, Billing fora, conflito de versao, cliente sem e-mail)
- [x] Instrucoes de setup claras
- [ ] TS-07 e TS-08 executados manualmente com evidencia (print do webhook.site / preview do Ethereal)

## Comandos Uteis

```bash
# unitarios com cobertura (listener, use case, orquestrador, regressao pos-commit, webhook)
npm run test:unit:cov
npx jest --config jest.unit.config.ts orquestrador-saga.eventos-pos-commit

# integracao (Testcontainers): repositorio de notificacao + e2e do callback
npx jest --config jest.integration.config.ts prisma-notificacao ordem-de-servico.e2e
npm run test:integration

# BDD (nivel de servico)
npm run test:bdd
npx cucumber-js --tags @notificacao

# consulta manual
curl -s "http://localhost:3000/notificacoes?ordemDeServicoId=<id>" -H "Authorization: Bearer $TOKEN_ATENDENTE" | jq '.data[] | {tipo, canal, numeroOS, eventoId, linkPagamento, status}'
```
