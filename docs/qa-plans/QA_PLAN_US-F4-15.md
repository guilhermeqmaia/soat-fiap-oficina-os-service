# QA Plan — US-F4-15: Testes de Contrato das APIs HTTP (OpenAPI por Serviço)

> Story: [`f4-15-testes-de-contrato.md`](../user-stories/f4-15-testes-de-contrato.md) · Contrato de
> transporte: [`http-interno.md`](../contratos/http-interno.md) (RFC-0008) · OpenAPI publicados:
> [`docs/contratos/openapi/`](../contratos/openapi/README.md) · Schemas:
> [`docs/contratos/schemas/`](../contratos/schemas/). O lado do os-service também está nos TS-07/TS-08
> do [`QA_PLAN_FLUXO-3.md`](QA_PLAN_FLUXO-3.md).

## Resumo

Valida que cada serviço exporta o seu OpenAPI 3 do Swagger do NestJS e o publica no hub com
`info.version` igual à versão do serviço; que o CI reprova quando o arquivo publicado diverge do
código, quando o lint (`redocly`) acusa problema, ou quando uma resposta real, uma requisição feita
aos participantes ou um callback foge do schema; e que o OS Service valida o envelope recebido em
`POST /ordens-servico/{numero}/eventos` (`400` com motivo, sem gravar em `processed_messages`). No
Billing, valida o teste de contrato e2e (`src/orcamento/contrato.e2e.spec.ts`) e a checagem do
`asyncapi.yaml` contra o do hub.

**Legenda de dependência**

| Marca | Significa |
|---|---|
| **[LOCAL]** | provado aqui, sem nuvem (Jest + supertest + ajv/jest-openapi, redocly, Testcontainers) |
| **[STUBS]** | Billing e Execução são os stubs de `e2e/stubs`, que validam as requisições do OS contra `docs/contratos/schemas` |
| **[AMBIENTE REAL]** | não se aplica a esta story |
| **[ADMIN]** | precisa de configuração de admin no GitHub (check obrigatório) |

## Pré-requisitos

- os-service: Node 20+, `npm ci`, `npx prisma generate`; Docker para `test:contracts` (o provedor sobe Postgres via Testcontainers).
- Billing: clone de `soat-fiap-oficina-billing-service`, Node 20, `npm ci`, `npx prisma generate`, Docker.
- Para o TS-07 manual: `npm run e2e:up` no os-service (compose da Fase 4) e `npm run -s e2e:token -- billing-service` para o JWT `SERVICO`.

## Cenários de Teste

### TS-01: OpenAPI exportado do código e publicado no hub, com versão = versão do serviço — [LOCAL]
- **Tipo:** Automatizado
- **Critério:** cada serviço exporta OpenAPI 3 (`npm run openapi:export`) e publica em `docs/contratos/openapi/<servico>.yaml`; `info.version` = versão do serviço
- **Passos:**
  1. os-service: `npm run openapi:export` e `git status docs/contratos/openapi/os-service.yaml`
  2. os-service: `npm run openapi:check`
  3. Versão: `node -p "require('./package.json').version"` × `grep -m1 '  version:' docs/contratos/openapi/os-service.yaml`
  4. Billing (no clone): `npm run openapi:export && git diff --exit-code openapi.yaml`
  5. Cópia no hub: `diff <billing>/openapi.yaml docs/contratos/openapi/billing-service.yaml` e versão (`0.1.0` no `package.json` e no `info.version`)
- **Resultado esperado:** export sem diferença (arquivo commitado em dia); `openapi:check` imprime `os-service.yaml em dia com o codigo`; os-service `1.1.0` = `1.1.0`; Billing idêntico ao do hub (conferido em 15/11/2026) e `0.1.0` = `0.1.0`
- **Alternativo:** controller/DTO alterado sem regerar → `openapi:check` (os-service) ou `git diff --exit-code openapi.yaml` (Billing) falha no CI
- **Pendente:** `execucao-service.yaml` "a publicar" — a Execução ainda não tem `openapi:export` (ver Rastreabilidade)

### TS-02: Endpoints internos com os códigos do contrato e segurança `SERVICO` — [LOCAL]
- **Tipo:** Automatizado (teste de contrato) + revisão
- **Critério:** endpoints de `http-interno.md` no OpenAPI com `201`/`200`/`409 { motivo }`/`404`, `bearer` com `x-role: SERVICO`; envelope do callback como schema compartilhado (`Envelope`) cujo `data` referencia os schemas por `type`
- **Passos:**
  1. `npm run test:contracts -- -t "o callback exige bearer com x-role SERVICO"` (os-service)
  2. `grep -n "x-role" docs/contratos/openapi/os-service.yaml`; `grep -n "Envelope" docs/contratos/openapi/os-service.yaml | head`
  3. Billing: `grep -n "'201'\|'404'\|'409'\|bearer" docs/contratos/openapi/billing-service.yaml`
- **Resultado esperado:** callback `POST /ordens-servico/{numero}/eventos` com `security: bearer`, `x-role: SERVICO` e respostas `200/400/401/403/404/409`; components `Envelope` e `EnvelopeCallback` (`oneOf` + `discriminator` por `type`, gerados de `docs/contratos/schemas/` por `src/config/openapi.ts`); Billing com `201`/`404`/`409` e `bearer` nos endpoints internos
- **Gap (15/11/2026):** o `billing-service.yaml` **não** marca os endpoints internos com `x-role: SERVICO` (a role é aplicada no código, mas não aparece no contrato publicado)

### TS-03: Lint bloqueante do OpenAPI no CI — [LOCAL]
- **Tipo:** Automatizado
- **Critério:** lint no CI (`@redocly/cli lint`), bloqueante; regra de compatibilidade documentada
- **Passos:**
  1. os-service: `npm run contracts:lint` (regras `recommended-strict` do `redocly.yaml`; exceções só para `/health` e `/health/ready` em `.redocly.lint-ignore.yaml`)
  2. Billing: `npx -y @redocly/cli@2.77.0 lint openapi.yaml`
  3. Provar o bloqueio: remover a descrição de uma resposta `4xx` numa cópia do YAML e rodar o lint de novo
  4. Ler a tabela "Versionar" de `docs/contratos/openapi/README.md`
- **Resultado esperado:** passos 1 e 2 sem erros; passo 3 com erro e código ≠ 0 (no os-service todo aviso vira erro); no CI os passos "Lint OpenAPI (redocly)" (os-service, passo 1 do `ci-cd.yml`) e "Lint do OpenAPI" (Billing, job `Lint, typecheck, testes (gate 80%) e build`); README define: campo novo opcional = **minor**, remoção/renomeação/mudança de código = **major** + rota `/v2/...`

### TS-04: Testes de contrato do OS Service (provedor, consumidor e fixtures) — [LOCAL]
- **Tipo:** Automatizado (CI: passo 1 do `ci-cd.yml`, "Run contract tests")
- **Critério:** testes de contrato no CI de cada serviço: respostas reais validadas contra o schema publicado; fixtures dos callbacks validadas contra `Envelope` + `data` do `type`
- **Passos:** `npm run test:contracts`
- **Resultado esperado:** 3 suítes verdes em `test/contracts/`:
  - `callback.provider.contract.spec.ts` — respostas reais do callback (válido, ignorado/fora de ordem, duplicado, OS inexistente `404`, conflito `409`, sem token `401`, envelope inválido `400`, `numeroOS` divergente do path `400`) e de `GET /notificacoes` / `GET /clientes/{cpfCnpj}/notificacoes` validam contra o `os-service.yaml`; o documento publicado está em dia e `info.version` = `package.json`
  - `participantes.consumer.contract.spec.ts` — a saga real percorre o fluxo e cada requisição do `HttpParticipantesSaga` (método, rota, corpo, `x-correlation-id`) e cada resposta esperada (incl. `201` do `cobrar` com `linkPagamento` e `409 { motivo }`) bate com `docs/contratos/schemas/endpoints-participantes.json`
  - `envelope.contract.spec.ts` — uma fixture por `type` em `test/contracts/fixtures/callbacks/` (6) valida contra o envelope, o schema do `type` e o `requestBody` publicado; rejeita `producer` trocado, preço em float e `type` que não chega por callback; aceita campo novo opcional (mudança minor); coerência entre schemas, `http-interno.md` e `asyncapi.yaml`

### TS-05: Teste de contrato do Billing (`contrato.e2e.spec.ts`) e AsyncAPI igual ao do hub — [LOCAL]
- **Tipo:** Automatizado (CI do Billing, job `Lint, typecheck, testes (gate 80%) e build`)
- **Critério:** testes de contrato no CI de cada serviço (lado do Billing); callbacks enviados validados contra `Envelope` + `data` do `type`
- **Passos:** no clone do Billing:
  1. `npx jest --config jest.integration.config.js src/orcamento/contrato.e2e.spec.ts` (o arquivo também roda dentro de `npm run test:integration`)
  2. `curl -fsSL https://raw.githubusercontent.com/guilhermeqmaia/soat-fiap-oficina-os-service/main/docs/contratos/asyncapi.yaml | diff - docs/contratos/asyncapi.yaml` (mesmo comando do passo "AsyncAPI igual ao do hub")
- **Resultado esperado:** suíte "Contrato HTTP (docs/contratos/http-interno.md)" verde — `POST /orcamentos` `201` e `200` (`toSatisfyApiSpec` contra o `openapi.yaml` publicado); aprovar, cobrar, webhook e callbacks de sucesso; rejeição e pagamento recusado; `409 { motivo }` de cobrar não aprovado; `DELETE` seguindo o schema. Cada callback interceptado (`nock`) valida contra o `ENVELOPE` (`producer: billing-service`) e o schema de `data` lido do `asyncapi.yaml`, com `data.numeroOS` = número da OS; `diff` vazio (conferido em 15/11/2026)
- **Alternativo:** alguém altera o `asyncapi.yaml` do hub sem atualizar a cópia do Billing → o passo "AsyncAPI igual ao do hub" falha no próximo CI do Billing (e vice-versa)

### TS-06: Requisições do OS validadas pelos stubs no ponta a ponta — [LOCAL] [STUBS]
- **Tipo:** Automatizado
- **Critério:** contrato exercitado entre containers (complementa o consumidor do TS-04)
- **Passos:** `npm run e2e:up && npm run test:bdd:e2e; npm run e2e:down`
- **Resultado esperado:** os stubs de `e2e/stubs` validam cada requisição do OS contra `docs/contratos/schemas`; o `After` do perfil `e2e` consulta `GET /__stub/violacoes` e reprova o cenário se houver divergência; 12 cenários verdes

### TS-07: Callback inválido é recusado com `400` e não entra em `processed_messages` — [LOCAL]
- **Tipo:** Automatizado (provedor) + Manual (compose)
- **Critério:** o OS Service valida o envelope recebido (`400` com motivo; nunca entra em `processed_messages`)
- **Passos:**
  1. `npm run test:contracts -- -t "envelope invalido"` e `-t "data.numeroOS diferente"`
  2. Manual, com `npm run e2e:up` e uma OS aberta (número `$N`):
     ```bash
     TOKEN=$(npm run -s e2e:token -- billing-service)
     ID=$(uuidgen | tr A-Z a-z)
     curl -s -w '\n%{http_code}\n' -X POST "http://localhost:3000/ordens-servico/$N/eventos" \
       -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
       -d '{"id":"'$ID'","type":"billing.orcamento-aprovado","version":0,"occurredAt":"2026-11-15T10:00:00Z","producer":"billing-service","data":{"numeroOS":"'$N'"}}'
     # repetir com "version":1 e "data":{"numeroOS":"OS-OUTRA"} (diverge do path)
     docker compose -f docker-compose.fase4.yml exec postgres-os \
       psql -U postgres -d oficina_os -c "select count(*) from processed_messages where id = '$ID'"
     ```
- **Resultado esperado:** passo 1 verde; passo 2: `400` com o motivo (`version` < 1 pelo `EnvelopeCallbackDto`; `data.numeroOS (OS-OUTRA) diverge do numero do path` no segundo envio), `count = 0`; a saga e a OS não mudam (`GET /ordens-servico/numero/$N/saga`)
- **Limite conhecido:** a validação **na entrada** é estrutural (`class-validator` no `EnvelopeCallbackDto`: `id` UUID, `type` no padrão `<dominio>.<fato>`, `version` ≥ 1, `occurredAt`, `producer`, `data` objeto, `numeroOS` = path). O `data` de cada `type` contra o JSON Schema completo (`callbacks.schema.json`) é garantido nos testes de contrato (fixtures do TS-04 e envelopes do Billing no TS-05), não em tempo de execução — um `producer` trocado, por exemplo, é barrado pelo contrato no CI, não pelo endpoint

### TS-08: Pact opcional — decisão registrada — [LOCAL]
- **Tipo:** Revisão
- **Critério:** opcional: Pact consumer/provider; se não, testes com supertest contra o schema bastam
- **Passos:** conferir `package.json` (sem `@pact-foundation/*`) e a seção "Validar" de `docs/contratos/openapi/README.md`
- **Resultado esperado:** Pact **não** adotado; o papel de consumer/provider é cumprido pelo par `participantes.consumer.contract.spec.ts` (OS como consumidor, contra `endpoints-participantes.json`) + `contrato.e2e.spec.ts` do Billing (provedor, contra o `openapi.yaml` publicado) + `callback.provider.contract.spec.ts` (OS como provedor do callback)

### TS-09: README dos contratos lista os arquivos, versões e comandos — [LOCAL]
- **Tipo:** Revisão
- **Critério:** `docs/contratos/openapi/README.md` lista os três arquivos, a versão e o comando de validação; renderização (Redoc) linkada no README do hub
- **Passos:** ler `docs/contratos/openapi/README.md`; `grep -n "contratos/openapi" README.md`; gerar o HTML: `npx -y @redocly/cli build-docs docs/contratos/openapi/os-service.yaml -o docs/contratos/html/os-service.html`
- **Resultado esperado:** tabela com `os-service.yaml` (publicado), `billing-service.yaml` (publicado, `0.1.0`) e `execucao-service.yaml` (*a publicar*); seções Gerar/Validar/Versionar com `openapi:export`, `openapi:check`, `contracts:lint`, `test:contracts`; README do hub linka `docs/contratos/openapi/`; o HTML gerado abre no navegador
- **Gaps (15/11/2026):** a coluna "Versão" do README diz `1.0.0` para o os-service, mas o `info.version` publicado é `1.1.0`; o README do hub linka a pasta, não uma renderização Redoc publicada (só o comando `build-docs`)

## Casos de Borda

- **Campo novo opcional** no envelope ou no `data`: continua válido (schemas sem `additionalProperties: false`) — teste "campo novo opcional … continua valido (mudanca minor)"
- **Status não declarado na operação:** o provedor reprova (ex.: controller passa a devolver `422` sem declarar)
- **Rota protegida sem `@ApiBearerAuth` nem `@RotaPublica()`:** o `openapi:export` quebra (evita publicar rota protegida como pública)
- **`/health` e `/health/ready` sem `4xx`:** únicas exceções do lint, em `.redocly.lint-ignore.yaml`; nenhuma rota do serviço deve entrar ali
- **`DELETE /orcamentos/{n}` antes de o orçamento existir:** `200` com `orcamentoId: null` (idempotente) — coberto no consumidor
- **`billing.cobrar` recusado (`409`, orçamento não aprovado):** não vira evento; a saga fica no passo
- **Mudança no `asyncapi.yaml` do hub:** quebra o CI do Billing até a cópia ser atualizada no mesmo ciclo

## Rastreabilidade

| Critério de aceite | Cenários | Status em 15/11/2026 |
|---|---|---|
| OpenAPI exportado e publicado no hub; `info.version` = versão | TS-01 | os-service e Billing OK; **Execução pendente** (sem export/publicação) |
| Endpoints do `http-interno.md` com códigos e `x-role: SERVICO`; `Envelope` compartilhado | TS-02 | os-service OK; Billing sem `x-role` |
| Lint no CI, bloqueante; regra de compatibilidade | TS-03 | os-service e Billing OK; Execução pendente |
| Testes de contrato no CI de cada serviço (respostas + fixtures de callbacks) | TS-04, TS-05, TS-06 | os-service e Billing OK; Execução pendente |
| Callbacks validados na entrada (`400`, fora de `processed_messages`) | TS-07 | provedor OK (validação estrutural; schema completo do `data` só no CI); manual a executar |
| Pact opcional | TS-08 | não adotado (decisão registrada) |
| README dos contratos + renderização linkada no hub | TS-09 | README OK; versão desatualizada na tabela e sem Redoc publicado |

## Checklist de Validação

- [x] TS-01 os-service e Billing (15/11/2026) — [ ] `execucao-service.yaml`
- [x] TS-02 os-service — [ ] `x-role: SERVICO` no `billing-service.yaml`
- [x] TS-03 lint (CI verde nos dois repos)
- [x] TS-04 `npm run test:contracts` (11/11/2026)
- [x] TS-05 `contrato.e2e.spec.ts` e AsyncAPI igual ao do hub (CI do Billing verde, `diff` vazio em 15/11/2026)
- [x] TS-06 stubs sem violações (BDD e2e, 11/11/2026)
- [ ] TS-07 manual com o compose
- [x] TS-08 decisão sobre Pact
- [ ] TS-09 corrigir a versão do os-service na tabela do README dos contratos
