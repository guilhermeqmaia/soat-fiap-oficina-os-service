# RFC-0008: Comunicação HTTP entre os serviços (substitui a mensageria)

**Status:** Aceita
**Data:** 2026-11-03
**Autores:** Time SOAT
**Substitui:** [RFC-0006](RFC-0006-mensageria.md) e [ADR-0009](../adr/ADR-0009-outbox-e-consumidor-idempotente.md)
**Stories relacionadas:** [US-F4-18](../../user-stories/f4-18-comunicacao-http-entre-servicos.md), [US-F4-10](../../user-stories/f4-10-saga-orquestrada.md), [US-F4-11](../../user-stories/f4-11-compensacoes-rollback.md), [US-F4-07](../../user-stories/f4-07-execucao-service.md), [US-F4-08](../../user-stories/f4-08-billing-orcamento.md)
**Contrato:** [`docs/contratos/http-interno.md`](../../contratos/http-interno.md)

## Contexto

Em 30/09 o time escolheu SNS + SQS FIFO (RFC-0006) com outbox transacional e
consumidor idempotente (ADR-0009) como transporte entre o OS Service, o Billing
e a Execução. O OS Service foi implementado nesse modelo (US-F4-06, US-F4-10,
US-F4-11): outbox, poller, 12 handlers SQS, LocalStack no compose, stage
`messaging/` no infra-k8s com 41 recursos.

Em **03/11/2026**, com a Execução e o Billing ainda por construir e três semanas
de calendário, o time reavaliou o custo dessa escolha:

- Cada serviço novo precisa de publisher, consumer, outbox, poller, filter policies,
  DLQ e LocalStack antes de escrever a primeira regra de negócio. Para quem entra
  agora (Execução e Billing) isso é a maior parte do esforço da história.
- Depurar o fluxo exige olhar três filas, uma DLQ e o outbox de cada serviço; o
  vídeo precisa mostrar o caminho feliz e uma compensação em 15 minutos.
- O enunciado da Fase 4 pede "comunicação entre serviços" com REST síncrono
  quando necessário e cita mensageria como exemplo, **não como obrigação**: o
  requisito avaliado é a saga com compensação, bancos próprios, CI/CD e
  observabilidade. O meio de transporte fica em aberto.
- Os três serviços rodam no mesmo cluster EKS, no mesmo namespace, com DNS
  interno; o volume é de dezenas de chamadas por OS.

A saga (RFC-0005), a máquina de estados da OS, os bancos por serviço e o API
Gateway não dependem do transporte. O que está em jogo é só **como** o
orquestrador fala com os participantes e como os participantes avisam o
orquestrador.

## Opções consideradas

### Opção A — Manter SNS + SQS FIFO com outbox e DLQ (escolha original)

- ✅ Já implementado no OS Service e provisionado no infra-k8s; desacoplamento temporal nativo; DLQ com triagem humana
- ✅ Alinhado ao que iFood/Nubank/Uber fazem em escala
- ❌ Execução e Billing ainda não existem: cada um precisa reproduzir publisher/consumer/outbox/DLQ antes do domínio (≈ um terço do esforço de 13 + 8 SP)
- ❌ Depuração e demo mais difíceis (filas, DLQ, outbox em três lugares); LocalStack obrigatório no BDD
- ❌ Mais recursos AWS para manter ligados e explicar no vídeo

### Opção B — HTTP síncrono entre serviços + callbacks HTTP para o OS Service

- ✅ Cada comando da saga vira **um endpoint** no participante e cada evento vira a **resposta** desse endpoint (quando o resultado é imediato) ou um **callback** `POST /ordens-servico/{numero}/eventos` no OS (quando depende de pessoa ou do Mercado Pago)
- ✅ Vocabulário, payloads e máquina de estados da saga **não mudam** — só o adaptador de transporte
- ✅ Depuração com `curl`, logs e traces HTTP que a Fase 3 já cobre; BDD sem LocalStack
- ✅ Execução e Billing nascem como APIs REST comuns (Swagger exigido pelo enunciado já cobre o contrato)
- ❌ Acoplamento temporal: se o participante está fora, a chamada falha — precisa de retry/backoff e de um caminho de recuperação (reprocessar)
- ❌ Perde a DLQ como fila de triagem; a "mensagem perdida" vira "saga parada" (que já tem métrica e endpoint)

### Opção C — Híbrido (HTTP para comandos, SQS para eventos/callbacks)

- ✅ Comandos síncronos simples; eventos assíncronos continuam duráveis
- ❌ Dois transportes para manter, documentar e testar; não elimina LocalStack nem o consumer SQS em nenhum serviço
- ❌ Pior dos dois mundos para o prazo: o esforço de infra continua e a depuração ganha mais um caminho

## Decisão

**Opção B — HTTP direto entre os serviços, com callbacks HTTP para o OS Service.**
O contrato efetivo é [`docs/contratos/http-interno.md`](../../contratos/http-interno.md);
o `asyncapi.yaml` passa a ser **vocabulário** (nomes e schemas de `data`).
Princípios que valem para os três serviços:

| Tema | Regra |
|---|---|
| Orquestração | O OS Service continua o orquestrador (RFC-0005); `SagaOS` não muda |
| Chamadas OS → serviço | HTTP síncrono pelo DNS interno do cluster; timeout 5 s; **3 tentativas com backoff exponencial** (200 ms, 800 ms, 3 s) só para `5xx`/timeout/rede; `4xx` não repete |
| Callbacks serviço → OS | `POST /ordens-servico/{numero}/eventos` com o envelope (`id`, `type`, `version`, `occurredAt`, `producer`, `data`); quem chama também aplica retry 3x; `200 { aplicado, duplicado?, passo, status }`, `409` em conflito de versão (repetir) |
| Idempotência | Comandos: chave = `numeroOS` (repetir não duplica efeito). Callbacks: chave = `id` do envelope (`processed_messages` no OS; duplicata devolve `200 { aplicado: false, duplicado: true }`) |
| Autenticação entre serviços | JWT com `role: SERVICO` e `sub` = nome do serviço, assinado com o mesmo `JWT_SECRET` da Lambda, emitido localmente (`mintServiceToken` do kit); endpoints internos e callbacks aceitam só `SERVICO` |
| Correlação | `x-correlation-id` (= número da OS) e `traceparent` propagados em toda chamada e callback |
| Erros de negócio | `409 { motivo }` = recusado (vira o evento de falha da saga); `404` = recurso desconhecido no destino (não repete) |
| Recuperação | Retry esgotado → saga fica no passo → alerta de saga parada (`oficina_os_sagas_paradas`) → `POST /admin/sagas/:numero/reprocessar` reenvia o comando do passo ou as compensações pendentes |
| Exposição | Os três serviços atrás do mesmo API Gateway (`/execucao|/catalogo|/estoque` → Execução); chamadas entre serviços **não passam** pelo gateway |

## Consequências

**O que fica:** saga orquestrada e sua matriz de compensação (RFC-0005, US-F4-11);
máquina de estados da OS com `AGUARDANDO_PAGAMENTO`; `saga_os` consultável;
bancos por serviço (RFC-0007, US-F4-03); API Gateway multi-serviço (ADR-0013);
`processed_messages` no OS (dedup de callbacks); vocabulário e schemas do AsyncAPI.

**O que sai:** outbox e poller; consumers e handlers SQS; stage `messaging/` do
infra-k8s (SNS, SQS, DLQ, alarmes de DLQ, parâmetros SSM); LocalStack no compose e
no BDD; variáveis `SNS_TOPIC_ARN`/`SQS_QUEUE_URL`; eventos `os.*` publicados (a
Notificação é in-process no OS, alimentada pelos callbacks). O módulo `messaging`
do kit fica no pacote marcado como descontinuado.

**Riscos e mitigação:**

| Risco | Mitigação |
|---|---|
| Chamada síncrona perdida (participante fora, timeout) | retry/backoff no cliente HTTP do kit; saga fica no passo; alerta de saga parada; `reprocessar` reenvia (idempotente por `numeroOS`) |
| Callback perdido (OS fora quando o participante avisa) | retry 3x no participante; estado fica no participante (ex.: orçamento aprovado); `reprocessar` no OS não resolve sozinho — runbook orienta reenviar o callback ou consultar o participante |
| Acoplamento temporal entre serviços | aceito: 3 serviços no mesmo cluster/namespace, HPA e health checks da Fase 3; não há pico de carga que justifique buffer |
| Ordem de eventos por OS | lock otimista em `ordem_de_servico`/`saga_os` + `409` no callback obriga o participante a reler e repetir |
| Perda da "trilha" do outbox para auditoria | `saga_os.historico` + audit log da OS + logs correlacionados por `x-correlation-id` |

**O que muda por repositório:**

| Repo | Mudança |
|---|---|
| kit | `Role.SERVICO`; `@guilhermeqmaia/oficina-kit/http` (cliente com timeout, retry/backoff, JWT de serviço, correlação); `mintServiceToken` em `testing`; `messaging` descontinuado |
| OS Service | remove outbox/poller/consumer/handlers SQS; `OrquestradorSagaService` chama Execução/Billing por HTTP e converte respostas em eventos; controller de callback; LocalStack sai do compose |
| Execução / Billing | expõem os endpoints de `http-interno.md`; chamam o callback do OS; sem fila |
| infra-k8s | remove o stage `messaging/`; gateway ganha o prefixo da Execução; nada de SNS/SQS nas vars |
| infra-db | sem mudança |
| auth-lambda | sem mudança (mesmo `JWT_SECRET`) |

**Follow-ups:** US-F4-18 (implementação); US-F4-15 passa a testar contratos
**OpenAPI** por serviço; US-F4-16 passa a propagar trace por HTTP (sem DLQ);
runbook [`saga-reprocessar.md`](../../runbooks/saga-reprocessar.md) substitui o da DLQ.

## Referências

- Enunciado da Fase 4: [`docs/tech-challenges/fase-4-tech-challenge.pdf`](../../tech-challenges/fase-4-tech-challenge.pdf) — "comunicação entre serviços" com REST e mensageria como exemplos; requisito avaliado = saga com compensação
- [RFC-0005 — Estratégia de Saga](RFC-0005-estrategia-de-saga.md) (inalterada)
- [RFC-0006 — Mensageria](RFC-0006-mensageria.md) e [ADR-0009](../adr/ADR-0009-outbox-e-consumidor-idempotente.md) (substituídas)
- [`docs/contratos/http-interno.md`](../../contratos/http-interno.md) — contrato efetivo
- AWS Prescriptive Guidance, [Padrão Saga](https://docs.aws.amazon.com/pt_br/prescriptive-guidance/latest/cloud-design-patterns/saga.html) — recuperação para frente (retry) × para trás (compensação)
