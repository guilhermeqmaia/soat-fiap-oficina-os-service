# OpenAPI por serviço

Cada serviço exporta o seu OpenAPI 3 a partir do Swagger do NestJS e publica aqui
([US-F4-15](../../user-stories/f4-15-testes-de-contrato.md)). Esta pasta é a fonte
dos testes de contrato no CI de cada serviço e a referência para quem consome a API.

| Arquivo | Serviço | Repositório | Versão | Status |
|---|---|---|---|---|
| [`os-service.yaml`](os-service.yaml) | OS Service (`/ordens-servico`, `/clientes`, `/veiculos`, `/usuario`, `/notificacoes`, `/auth/me`, `/admin`, callback `/ordens-servico/{numero}/eventos`) | `soat-fiap-oficina-os-service` | 1.0.0 | publicado (gerado por `npm run openapi:export`) |
| `billing-service.yaml` | Billing (`/orcamentos`, `/pagamentos`, `/webhooks/mercadopago`) | `soat-fiap-oficina-billing-service` | — | *a publicar* (a branch `feat/fluxo-2-billing` já gera `openapi.yaml` na raiz do repo) |
| `execucao-service.yaml` | Execução (`/execucao`, `/catalogo`, `/estoque`) | `soat-fiap-oficina-execucao-service` | — | *a publicar* |

## De onde vem cada parte

| Parte | Fonte | Observação |
|---|---|---|
| Rotas, parâmetros, DTOs, códigos de resposta | decorators `@nestjs/swagger` dos controllers | Uma operação sem `@ApiBearerAuth` nem `@RotaPublica()` quebra o export (evita publicar uma rota protegida como pública). |
| Envelope do callback e `data` de cada `type` | [`../schemas/`](../schemas/) (JSON Schema draft-07) | Convertidos para components OAS 3.0 por `src/config/openapi.ts`: `Envelope`, `EnvelopeCallback` (`oneOf` + `discriminator` por `type`) e uma variante por callback. |
| Requisições/respostas que o OS **consome** (Billing/Execução) | [`../schemas/endpoints-participantes.json`](../schemas/endpoints-participantes.json) + `comandos.schema.json` + `eventos.schema.json` | Não entram no `os-service.yaml` (não são API do OS); cada participante as publica no seu próprio arquivo. |

O Swagger UI do serviço (`/api`, fora de produção) usa a mesma função
(`criarDocumentoOpenApi`), então o que se vê em `/api` é o que está publicado aqui.

## Gerar

```bash
npm run openapi:export        # grava docs/contratos/openapi/os-service.yaml (sem banco: Nest em modo preview)
npm run openapi:check         # falha se o arquivo commitado não bate com os controllers
```

Regere e commite o YAML no mesmo PR de qualquer mudança em controller, DTO ou schema.
O teste `callback.provider.contract.spec.ts` também falha se o arquivo estiver desatualizado.

## Validar

```bash
npm run contracts:lint        # redocly lint, regras recommended-strict (todo aviso é erro)
npm run test:contracts        # Jest + supertest + ajv (faz parte de `npm test`)
```

- **Lint** (`redocly.yaml` na raiz): bloqueante. Exceções pontuais vão em
  `.redocly.lint-ignore.yaml` — hoje só `/health` e `/health/ready`, que vêm do kit sem 4xx.
- **Testes de contrato** (`test/contracts/`):
  - *provedor* — respostas reais do callback (válido, ignorado, duplicado, OS inexistente,
    conflito, role errada, sem token, envelope inválido) e de `GET /notificacoes` /
    `GET /clientes/{cpfCnpj}/notificacoes` validam contra este OpenAPI; status não declarado
    na operação reprova;
  - *consumidor* — a `SagaOS` real percorre o fluxo e cada requisição do
    `HttpParticipantesSaga` (método, rota, corpo, `x-correlation-id`) e cada resposta
    esperada (incl. `201` do `cobrar` com `linkPagamento` e `409 { motivo }`) é conferida
    contra `endpoints-participantes.json`;
  - *fixtures* — `test/contracts/fixtures/callbacks/<type>.json` (um por callback) validam
    contra o envelope, o schema do `type` e o `requestBody` publicado.
- Renderizar: `npx -y @redocly/cli build-docs docs/contratos/openapi/os-service.yaml -o docs/contratos/html/os-service.html`.

## Versionar

`info.version` = `version` do `package.json` do serviço (o export lê de lá).

| Mudança | Exemplo | Versão | Rota |
|---|---|---|---|
| Campo **novo opcional** na resposta ou no `data` do envelope | `linkPagamento?` em `NotificacaoResponseDto` | **minor** (`1.0.0` → `1.1.0`) | mesma |
| Novo endpoint, novo código de resposta opcional para o cliente, novo `type` de callback | novo `billing.reembolso-concluido` | **minor** | mesma |
| Correção de descrição/exemplo, sem mudar schema | — | **patch** | mesma |
| **Remoção ou renomeação** de campo, campo que passa a ser obrigatório na requisição, mudança de tipo | `valor` number → string | **major** (`1.x` → `2.0.0`) | rota versionada (`/v2/...`) convivendo com a antiga até os consumidores migrarem |
| **Mudança de código de resposta** existente | `201` → `200` no `cobrar` | **major** | `/v2/...` |

Os schemas toleram campos extras (`additionalProperties` não é fechado) justamente para que
o campo novo opcional seja compatível nos dois sentidos. No envelope, o mesmo vale para
`version`: muda só quando o `data` do `type` muda de forma incompatível.

## Regras gerais

- Os endpoints internos (`SERVICO`, extensão `x-role`) e o callback seguem
  [`../http-interno.md`](../http-interno.md); os nomes dos `type`s e os campos do `data`
  vêm do [`../asyncapi.yaml`](../asyncapi.yaml) (o teste de contrato confere os campos
  obrigatórios entre os dois).
- Mudou uma tabela do `http-interno.md`? Mude o JSON Schema em `../schemas/` no mesmo PR.
