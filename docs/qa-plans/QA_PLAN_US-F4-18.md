# QA Plan — US-F4-18: Comunicacao HTTP entre Servicos (kit, OS Service, Billing, Execucao, infra)

## Resumo
Valida a troca da mensageria SNS/SQS por HTTP direto (RFC-0008): o cliente HTTP interno do kit (timeout, retry/backoff, JWT `SERVICO`, correlacao), o endpoint de callback `POST /ordens-servico/{numero}/eventos` do OS Service (validacao, dedup por `id`, `404`/`409`), a conversao das respostas sincronas em eventos da saga, a remocao de outbox/SQS/LocalStack e do stage `messaging/`, e a exposicao da Execucao no gateway. Contrato: `docs/contratos/http-interno.md`.

## Pre-requisitos
- Kit na versao com `/http`, `Role.SERVICO` e `mintServiceToken` (`npm ls @guilhermeqmaia/oficina-kit`)
- OS Service com a migration que remove `outbox`; `.env` com `EXECUCAO_SERVICE_URL`, `BILLING_SERVICE_URL`, `JWT_SECRET` (mesmo da Lambda)
- Para TS-05..TS-08: Execucao e Billing (ou mocks HTTP — WireMock/nock) respondendo nas URLs acima; `docker compose up` sem o profile `messaging`
- Tokens: `mintToken` (usuarios) e `mintServiceToken({ servico: 'execucao-service' })` do kit `/testing`
- Para TS-11/12: repo infra-k8s com Terraform >= 1.9 e profile `oficina`

## Cenarios de Teste

### TS-01: Cliente HTTP do kit — retry so em falha de plataforma
- **Tipo:** Automatizado (unitarios do kit)
- **Criterio:** 3 tentativas com backoff (200/800/3000 ms) para `5xx`/timeout/rede; `4xx` nao repete
- **Passos:** mock de servidor devolvendo `503, 503, 201`; depois `409`; depois timeout permanente
- **Resultado esperado:** 1o caso: sucesso na 3a tentativa, backoff respeitado (fake timers); 2o: uma chamada e erro tipado `RecusaDeNegocioError { motivo }`; 3o: 3 tentativas e `ChamadaEsgotadaError`

### TS-02: Cabecalhos de servico e correlacao
- **Tipo:** Automatizado (kit)
- **Criterio:** JWT `SERVICO` + `x-correlation-id` + `traceparent`
- **Passos:** chamar o cliente dentro de um contexto de request com `x-correlation-id: OS-2026-0001`; inspecionar a requisicao recebida pelo mock
- **Resultado esperado:** `Authorization: Bearer <jwt>` com `role: SERVICO`, `sub` = nome do servico, `iss=oficina-auth-lambda`; `x-correlation-id` igual ao da request; `traceparent` presente

### TS-03: Guard aceita SERVICO e recusa usuarios
- **Tipo:** Automatizado (e2e do OS Service)
- **Criterio:** Endpoints internos so `SERVICO`
- **Passos:** `POST /ordens-servico/{n}/eventos` com token ADMIN, CLIENTE, sem token, e com `mintServiceToken`
- **Resultado esperado:** `403`, `403`, `401`, `200`; o inverso: `POST /ordens-servico` com token `SERVICO` -> `403`

### TS-04: Callback — envelope valido, duplicado, OS inexistente, conflito
- **Tipo:** Automatizado (e2e)
- **Criterio:** `200 { aplicado, passo, status }`, dedup por `id`, `404`, `409`
- **Passos:**
  1. OS em `AGUARDAR_DIAGNOSTICO`; enviar `execucao.diagnostico-concluido` com itens validos
  2. Reenviar o mesmo envelope (mesmo `id`)
  3. Enviar para numero inexistente
  4. Enviar envelope sem `id`/`type` invalido
  5. Simular conflito de versao (duas requisicoes concorrentes na mesma OS)
- **Resultado esperado:** 1) `200 { aplicado: true, passo: 'GERAR_ORCAMENTO' ... }`, snapshot gravado, `processed_messages` com o `id`; 2) `200 { aplicado: false, duplicado: true }` sem efeito; 3) `404`; 4) `400`; 5) uma `200` e uma `409`, OS consistente

### TS-05: Resposta sincrona vira evento da saga
- **Tipo:** Automatizado (unitarios do orquestrador com cliente mockado) + e2e com mock HTTP
- **Criterio:** `201` de `POST /execucao/ordens` ≙ `execucao.enfileirada`; `409` ≙ `execucao.recusada`
- **Passos:** `POST /ordens-servico` com o mock da Execucao devolvendo `201 { posicaoFila: 1 }`; repetir com `409 { motivo: 'veiculo ja em execucao' }`
- **Resultado esperado:** 1o: OS `EM_DIAGNOSTICO`, saga `AGUARDAR_DIAGNOSTICO`, historico com `execucao.enfileirada`; 2o: OS `CANCELADA` com `EXECUCAO_RECUSADA`

### TS-06: Chamada apos o commit e retry esgotado -> saga parada -> reprocessar
- **Tipo:** Automatizado (e2e) + Manual
- **Criterio:** Retry esgotado nao compensa; `reprocessar` repete a chamada
- **Passos:** mock da Execucao devolvendo `503` sempre; `POST /ordens-servico`; observar `/metrics`; subir o mock; `POST /admin/sagas/{n}/reprocessar`
- **Resultado esperado:** OS criada (`RECEBIDA`) e saga em `ENFILEIRAR_EXECUCAO` com historico `chamada-falhou` (3 tentativas); `oficina_os_sagas_paradas` = 1; `oficina_os_http_interno_total{resultado="esgotado"}` incrementa; apos reprocessar: `reenviados: ['execucao.enfileirar']`, OS `EM_DIAGNOSTICO`

### TS-07: Caminho feliz ponta a ponta por HTTP
- **Tipo:** Manual (compose com os tres servicos) ou e2e com mocks
- **Criterio:** Fluxo de `http-interno.md` (pagamento apos a execucao)
- **Passos:** abrir OS -> diagnostico na Execucao -> aprovar no Billing -> finalizar na Execucao -> webhook do Mercado Pago (replay assinado, `docs/mercado-pago-sandbox.md`) -> entregar
- **Resultado esperado:** OS passa por `EM_DIAGNOSTICO -> AGUARDANDO_APROVACAO -> EM_EXECUCAO -> AGUARDANDO_PAGAMENTO -> FINALIZADA -> ENTREGUE`; `GET .../saga` mostra cada chamada e callback; notificacao com `linkPagamento` apos `cobranca-criada`; nenhum container LocalStack

### TS-08: Compensacao por DELETE
- **Tipo:** Automatizado (e2e com mocks)
- **Criterio:** Rejeicao -> `DELETE /execucao/ordens/{n}`; timeout de aprovacao -> os dois `DELETE`
- **Passos:** callback `billing.orcamento-rejeitado`; noutra OS, vencer `SAGA_TIMEOUT_APROVACAO_MS`
- **Resultado esperado:** mocks recebem os `DELETE` com `{ motivo }` e JWT `SERVICO`; `compensacoes[].confirmadaEm` preenchido pelo `200`; OS `CANCELADA` com o motivo certo

### TS-09: Codigo de mensageria removido
- **Tipo:** Automatizado (`architecture.spec.ts`, CI)
- **Criterio:** Sem outbox/SQS/LocalStack
- **Passos:** `grep -r "OutboxPoller\|SqsConsumer\|SNS_TOPIC_ARN" src k8s* docker-compose.yml .env.example`; `npx prisma migrate deploy` num banco com `outbox`
- **Resultado esperado:** nenhum resultado; tabela `outbox` removida; `processed_messages` e `saga_os` intactas; app sobe sem `AWS_ENDPOINT`

### TS-10: Participantes chamam o callback com retry
- **Tipo:** Automatizado (testes do Billing/Execucao com o OS mockado)
- **Criterio:** Callback com JWT `SERVICO`, 3 tentativas, `409` -> reler e repetir
- **Passos:** aprovar orcamento com o mock do OS devolvendo `503, 200`; depois `409, 200`
- **Resultado esperado:** envelope `billing.orcamento-aprovado` entregue; `id` igual nas repeticoes; estado local do participante gravado antes do callback

### TS-11: infra-k8s — stage `messaging/` removido e gateway com Execucao
- **Tipo:** Manual (Terraform)
- **Criterio:** Sem SNS/SQS; `/execucao*`, `/catalogo*`, `/estoque*`, `/admin*` roteados
- **Passos:** `terraform destroy` no stage `messaging/` (documentado) ou remocao do diretorio + `terraform plan` nos demais stages; `terraform output route_map` no stage `gateway/`; `aws ssm get-parameters-by-path --path /oficina/messaging`
- **Resultado esperado:** nenhum recurso SNS/SQS/alarme de DLQ; `route_map` com os tres backends e `/admin*` -> OS; SSM vazio; `gh variable list` sem `SNS_TOPIC_ARN`/`SQS_QUEUE_URL`

### TS-12: Chamadas internas nao passam pelo gateway
- **Tipo:** Manual (EKS)
- **Criterio:** DNS interno + `SERVICO` nunca emitido pela Lambda
- **Passos:** de um pod do OS: `curl http://execucao-service:3002/health`; pelo gateway: `curl $GW/ordens-servico/OS-1/eventos -H "Authorization: Bearer <token de usuario>"`
- **Resultado esperado:** `200` interno; `403` pelo gateway (role de usuario); logs dos tres servicos com o mesmo `correlation_id` numa OS

## Casos de Borda
- Participante responde `200` mas o OS cai antes de gravar: a chamada e idempotente por `numeroOS` — reprocessar repete e o participante devolve o mesmo resultado (`200` com o existente)
- Callback chega antes de a resposta sincrona ser aplicada (ex.: diagnostico muito rapido): `409`/fora de ordem -> participante repete apos backoff; a saga ignora o que ja passou
- JWT `SERVICO` expirado durante o retry: o cliente reemite (`mintServiceToken` com cache ate expirar)
- `JWT_SECRET` diferente entre servicos: `401` em todo callback — alerta de saga parada e o primeiro sinal; conferir o Secrets Manager
- Envelope com `version` maior que a suportada: `400` com motivo; nao entra em `processed_messages`

## Rastreabilidade
| Criterio | Cenarios |
|---|---|
| Kit: `Role.SERVICO`, cliente HTTP, `mintServiceToken` | TS-01, TS-02, TS-03 |
| OS: orquestrador por HTTP, respostas viram eventos | TS-05, TS-07, TS-08 |
| OS: endpoint de callback, dedup por `id`, `404`/`409` | TS-04 |
| OS: outbox/SQS/LocalStack removidos | TS-09 |
| OS: retry esgotado -> saga parada -> reprocessar | TS-06 |
| Billing/Execucao: endpoints e callbacks do contrato | TS-07, TS-10 |
| infra-k8s: `messaging/` removido, gateway com Execucao | TS-11, TS-12 |
| Hub: compose sem LocalStack | TS-07 |

## Checklist de Validacao
- [ ] TS-01..TS-06 (kit + OS Service)
- [ ] TS-07, TS-08 (ponta a ponta / compensacao)
- [ ] TS-09 (remocao)
- [ ] TS-10 (Billing/Execucao)
- [ ] TS-11, TS-12 (infra, no proximo ciclo de deploy)
