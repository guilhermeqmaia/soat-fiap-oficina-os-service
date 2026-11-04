# US-F4-15: Testes de Contrato das APIs HTTP (OpenAPI por servico)

**User Story:** Como Desenvolvedor, quero que cada servico publique seu OpenAPI versionado no hub e que o CI valide requests, respostas e callbacks contra esse schema, para que uma mudanca incompativel num endpoint quebre o build e nao a producao.

**Prioridade:** Media
**Story Points:** 3
**Status:** To Do (reescrita em 03/11/2026: contratos de API HTTP no lugar de schemas de eventos — RFC-0008)
**DDD Domain:** Todos (integracao)
**DDD Layer:** Testes
**Repositorio:** hub (`docs/contratos/openapi/`) + os-service, billing-service, execucao-service

## Contexto

Com a RFC-0008 o contrato entre os servicos e **HTTP**: endpoints `SERVICO` nos
participantes e o callback `POST /ordens-servico/{numero}/eventos` no OS Service
([`http-interno.md`](../contratos/http-interno.md)). O Swagger que cada servico ja
gera (exigido pelo enunciado) vira o contrato testavel; o `asyncapi.yaml` continua
como vocabulario dos `type`s e dos schemas de `data` do envelope.

## Criterios de Aceite

- [ ] Cada servico exporta seu OpenAPI 3 (`npm run openapi:export` -> `openapi.yaml` gerado do Swagger do NestJS) e o publica no hub em `docs/contratos/openapi/<servico>.yaml` (`os-service.yaml`, `billing-service.yaml`, `execucao-service.yaml`) por PR automatico ou copia no CI; versao no `info.version` = versao do servico
- [ ] Os endpoints de `http-interno.md` aparecem no OpenAPI com os codigos de resposta do contrato (`201`/`200`/`409 { motivo }`/`404`) e a seguranca `bearer` com `x-role: SERVICO`; o envelope do callback e um schema compartilhado (`Envelope`) cujo `data` referencia os schemas do `asyncapi.yaml` por `type`
- [ ] **Lint no CI** (`@redocly/cli lint` ou `spectral`) de cada OpenAPI, bloqueante; regra de compatibilidade: campo novo opcional = minor; remocao/renomeacao/mudanca de codigo de resposta = major + rota versionada (`/v2/...`)
- [ ] **Testes de contrato no CI de cada servico**: `supertest` + `jest-openapi` (ou `express-openapi-validator`) validando que as respostas reais dos endpoints `SERVICO` e dos endpoints de usuario batem com o schema publicado; fixtures de todos os callbacks que o servico **envia** validadas contra o schema `Envelope` + `data` do `type`
- [ ] **Callbacks validados na entrada**: o OS Service valida o envelope recebido em `POST /ordens-servico/{numero}/eventos` contra o schema (`400` com motivo se invalido; nunca entra em `processed_messages`)
- [ ] Opcional (se o time quiser): Pact consumer/provider entre OS Service (consumer) e Billing/Execucao (providers) com o broker em `pactflow` free ou arquivo no hub; se nao, os testes com supertest contra o schema bastam
- [ ] `docs/contratos/openapi/README.md` lista os tres arquivos, a versao e o comando de validacao; renderizacao (Redoc) linkada no README do hub

## O que salva no banco

Nao se aplica (historia de testes/documentacao).

## Dependencias

- [US-F4-18](f4-18-comunicacao-http-entre-servicos.md), [US-F4-DOC-03](f4-doc-03-contratos-eventos.md) (vocabulario), [US-F4-07](f4-07-execucao-service.md), [US-F4-08](f4-08-billing-orcamento.md)
