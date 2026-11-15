# Notificação ao cliente (e-mail Brevo/SMTP ou webhook) — US-20 / US-F4-12

A oficina notifica o cliente em cada **marco da OS**, com os fatos que chegam
pelos callbacks/respostas HTTP da saga (Fase 4, US-F4-12) e pelas transições
locais. O envio é um **adapter plugável** na porta `Notificador`, selecionado
por env; a notificação é gravada com o **canal real** (`EMAIL` ou `WEBHOOK`).

## Marcos notificados (US-F4-12)

| Fato (vocabulário de `docs/contratos/http-interno.md`) | Origem | `tipo` | Observação |
|---|---|---|---|
| `billing.orcamento-gerado` | `201` de `POST /orcamentos` | `ORCAMENTO_PRONTO` | diagnóstico + total; aprovar/rejeitar no portal |
| `billing.orcamento-aprovado` | callback do Billing | `ORCAMENTO_APROVADO` | **sem** link (a cobrança vem depois da execução, ADR-0012) |
| `billing.cobranca-criada` | `201` de `POST /orcamentos/{n}/cobrar` | `PAGAMENTO_PENDENTE` | **com `linkPagamento`** na mensagem e na coluna `link_pagamento` |
| `billing.pagamento-aprovado` | callback do Billing | `PAGAMENTO_APROVADO` | |
| `billing.pagamento-recusado` | callback do Billing | `PAGAMENTO_RECUSADO` | motivo; a OS segue `AGUARDANDO_PAGAMENTO` |
| transição → `FINALIZADA` | `billing.pagamento-aprovado` aplicado | `OS_FINALIZADA` | veículo pronto para retirada |
| transição → `CANCELADA` | rejeição, timeout, recusa da Execução ou atendente | `OS_CANCELADA` | motivo do cancelamento |
| outras transições (`EM_DIAGNOSTICO`, `EM_EXECUCAO`, `ENTREGUE`) | transição local | `STATUS_OS_ALTERADO` | genérica (Fase 2) |

A genérica `STATUS_OS_ALTERADO` é suprimida para `AGUARDANDO_APROVACAO`,
`AGUARDANDO_PAGAMENTO`, `FINALIZADA` e `CANCELADA`
(`STATUS_COM_NOTIFICACAO_DEDICADA` no listener), que já têm notificação própria.

### Fluxo e garantias

```
callback / resposta HTTP --> ReceberCallbackUseCase (dedup em processed_messages)
                         --> OrquestradorSagaService: transacao (OS + saga)
                               '- eventos acumulados em EventosDaTransacao
                         --> COMMIT --> MarcoOrdemDeServicoEvent no EventEmitter
                         --> OrdemDeServicoNotificacaoListener --> EnviarNotificacaoUseCase
                               reserva (PENDENTE) -> envia -> ENVIADA / FALHOU
```

- **Só depois do commit.** Cada tentativa de transação acumula seus eventos;
  se a transação reverte (conflito de versão → retry do orquestrador), os
  eventos daquela tentativa são descartados. Nenhum listener vê fato revertido.
- **Só fato aplicado.** O marco sai apenas quando a saga aceita o evento
  (`aplicado = true`). Callback com `id` repetido para no `processed_messages`;
  evento duplicado/fora de ordem com outro `id` é ignorado pela saga. Nenhum
  dos dois notifica.
- **Uma notificação por fato.** Índice único `(evento_id, tipo, canal)`:
  - `evento_id` = `id` do envelope do callback; para respostas síncronas, id
    determinístico com o recurso criado (`billing.cobranca-criada:<n>:<orderId>`,
    `billing.orcamento-gerado:<n>:<orcamentoId>`); para as transições terminais,
    `os.finalizada:<n>` / `os.cancelada:<n>`; para a genérica, `os.status:<n>:<status>`.
  - Por que não `(tipo, OS)`: alguns fatos se repetem legitimamente na mesma OS.
    Cada pagamento recusado e cada **nova cobrança** (reprocessar → outro `orderId`
    → outro link) devem avisar o cliente.
  - `tipo` entra porque um fato gera mais de um tipo (`pagamento-aprovado` →
    `PAGAMENTO_APROVADO` + `OS_FINALIZADA`); `canal` entra para o mesmo fato poder
    sair por e-mail **e** por webhook.
- **Já notificado não reenvia.** O use case grava a linha `PENDENTE` **antes**
  de enviar; violação do índice (Prisma `P2002`) é registrada como
  `Ja notificado ...` (log `warn`), não é erro e o envio não acontece.
  Notificações antigas (`evento_id` NULL) não entram na unicidade.
- **Cliente sem e-mail:** o canal `EMAIL` é pulado (log `warn`); o `WEBHOOK`
  ainda notifica (destinatário registrado = id do cliente).

### Consulta

`GET /clientes/:cpfCnpj/notificacoes` (CLIENTE, dono do CPF) e `GET /notificacoes`
(ADMIN/ATENDENTE) mantêm o formato e ganharam os campos **opcionais**
`numeroOS`, `eventoId` e `linkPagamento` (null nas notificações antigas).

Provider padrão do projeto: **`email` via Brevo** (SMTP, free tier).

| `NOTIFICATION_PROVIDER` | Efeito |
|---|---|
| `email` / `smtp` (**default**) | Envia e-mail de verdade via SMTP (nodemailer/Brevo). Canal `EMAIL`. |
| `mock` | Só loga o envio (dev/demo sem dependências). Canal `EMAIL`. |
| `webhook` | POST assinado com HMAC-SHA256 para `NOTIFICATION_WEBHOOK_URL`. Canal `WEBHOOK`. |

### Webhook

Corpo (US-F4-12), assinado com `X-Signature: sha256=<hex>` (HMAC-SHA256 do corpo
exato com `NOTIFICATION_WEBHOOK_SECRET`) e com o `X-Correlation-Id` da requisição de origem:

```json
{
  "numeroOS": "OS-2026-000123",
  "tipo": "PAGAMENTO_PENDENTE",
  "mensagem": "Ola Joao,\n\nO servico da sua Ordem de Servico OS-2026-000123 foi concluido...",
  "linkPagamento": "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=...",
  "ordemId": "...", "clienteId": "...", "statusAnterior": null, "statusAtual": null,
  "timestamp": "2026-11-10T12:00:00.000Z", "tipoNotificacao": "PAGAMENTO_PENDENTE"
}
```

`linkPagamento` só aparece quando existe. Os campos depois dele são os da Fase 2,
mantidos para não quebrar quem já consome. Retry simples: 2 tentativas.

## Arquitetura (Clean / Hexagonal)

- **Application** só conhece a porta `Notificador`
  (`application/ports/notificador.port.ts`) e a interface `MensagemNotificacao`.
  O listener (`OrdemDeServicoNotificacaoListener`) e o
  `EnviarNotificacaoUseCase` não sabem que existe SMTP/Brevo.
- **Infrastructure** implementa a porta:
  `infrastructure/smtp-email-notificador.adapter.ts` fala nodemailer e lê as
  variáveis via `ConfigService`. Trocar Brevo por outro provedor é só env — nada
  na aplicação/domínio muda.
- **Composição**: `notificacao.module.ts` escolhe o adapter por
  `NOTIFICATION_PROVIDER`. A notificação é **persistida** (reservada como
  `PENDENTE`, depois `ENVIADA` ou `FALHOU`) mesmo quando o envio falha
  (visível no admin e no portal).

## Comportamento sem credenciais (funciona já, real depois)

Enquanto `SMTP_USER`/`SMTP_PASS` estiverem **vazios**, o adapter cria uma **conta
de teste Ethereal** em runtime (zero cadastro) e loga um link de preview:

```
[SmtpEmailNotificador] [EMAIL] enviado to=cl*****@email.com ... preview=https://ethereal.email/message/XXXX
```

Abra o `preview=` no navegador para ver o e-mail. Assim que você preencher as
credenciais do Brevo, os e-mails passam a sair de verdade — sem mudar código.

## Setup do Brevo (fazer depois)

1. Crie a conta em <https://www.brevo.com> (free tier: ~300 e-mails/dia).
2. **Verifique um remetente** (Senders & IP → adicione/valide o e-mail que vai no
   `EMAIL_FROM`). O Brevo recusa enviar de remetentes não verificados.
3. Pegue as credenciais em **Transactional → SMTP**:
   - `SMTP_USER` = e-mail de login da conta Brevo.
   - `SMTP_PASS` = a **SMTP key** gerada ali (não é a senha do site).
4. Preencha `SMTP_USER`, `SMTP_PASS` e `EMAIL_FROM`:
   - **Local**: no `.env` (já vem com `NOTIFICATION_PROVIDER=email` e o host do Brevo).
   - **Kubernetes**: em `k8s/configmap.yaml` (as chaves já existem). Depois:
     ```bash
     kubectl apply -k k8s/
     kubectl rollout restart deployment/oficina-app -n oficina
     ```

> As credenciais podem ficar no ConfigMap (free tier, sem risco relevante). Se
> preferir mantê-las secretas, mova `SMTP_PASS` para o Secret `oficina-app`
> (ver `k8s/secret.yaml.example`) — o `envFrom` faz o Secret prevalecer.

## Variáveis

| Var | Default | Descrição |
|---|---|---|
| `NOTIFICATION_PROVIDER` | `email` | `email` \| `mock` \| `webhook`. |
| `SMTP_HOST` | `smtp-relay.brevo.com` | Host SMTP. Vazio ⇒ Ethereal. |
| `SMTP_PORT` | `587` | Porta SMTP. |
| `SMTP_SECURE` | `false` | `true` só na porta 465. |
| `SMTP_USER` | — | Login SMTP (Brevo). Vazio ⇒ Ethereal. |
| `SMTP_PASS` | — | SMTP key (Brevo). |
| `EMAIL_FROM` | `Oficina Mecanica <...>` | Remetente (verificado no Brevo). |
| `NOTIFICATION_WEBHOOK_URL` | — | URL do webhook (`NOTIFICATION_PROVIDER=webhook`). |
| `NOTIFICATION_WEBHOOK_SECRET` | — | Segredo do HMAC (`X-Signature`). |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | `5000` | Timeout de cada tentativa. |

## Como testar

Dispare uma transição que notifica o cliente (o cliente da OS precisa ter e-mail;
as seeds de demo já têm):

- **Orçamento pronto** (`billing.orcamento-gerado`) → `ORCAMENTO_PRONTO`.
- **Orçamento aprovado** (callback `billing.orcamento-aprovado`) → `ORCAMENTO_APROVADO`.
- **Serviço concluído** (`201` do cobrar) → `PAGAMENTO_PENDENTE` com o link.
- **Pagamento aprovado/recusado** (callbacks) → `PAGAMENTO_APROVADO` + `OS_FINALIZADA` / `PAGAMENTO_RECUSADO`.
- **Cancelamento** → `OS_CANCELADA`.
- **Outras transições** → `STATUS_OS_ALTERADO`.

Confira: o log da app (`preview=` no modo Ethereal, ou `messageId` no Brevo) **e**
o histórico de notificações no admin (`/notificacoes`) e no portal do cliente.

## Testes automatizados

`src/notificacao/infrastructure/smtp-email-notificador.adapter.spec.ts` cobre:
envio via SMTP real, `secure` derivado da porta 465, reuso do transporte,
fallback Ethereal (sem host **e** sem credenciais), escape de HTML e propagação
de erro.

```bash
npm run test:unit -- smtp-email-notificador
```

US-F4-12:

| Teste | O que cobre |
|---|---|
| `orquestrador-saga.eventos-pos-commit.spec.ts` | regressão: conflito de versão + retry não publica os eventos da tentativa revertida; nada sai dentro da transação |
| `orquestrador-saga.service.spec.ts` (`marcos para a notificacao`) | marcos dos `billing.*`, link do cobrar, id determinístico, duplicado sem marco |
| `ordem-de-servico.listener.spec.ts` | os 7 tipos, mensagens, link, supressão da genérica |
| `enviar-notificacao.use-case.spec.ts` | reserva → envio, "já notificado", canal `WEBHOOK`, cliente sem e-mail |
| `webhook-notificador.adapter.spec.ts` | payload `{ numeroOS, tipo, mensagem, linkPagamento? }` + HMAC |
| `prisma-notificacao.repository.integration.spec.ts` | índice único `(evento_id, tipo, canal)` no Postgres (Testcontainers) |
| `ordem-de-servico.e2e.spec.ts` (`notificacoes ao cliente`) | callback → `GET /notificacoes`; duplicado não notifica |
| `features/ordem-de-servico.feature` | BDD com as verificações dos tipos novos |
