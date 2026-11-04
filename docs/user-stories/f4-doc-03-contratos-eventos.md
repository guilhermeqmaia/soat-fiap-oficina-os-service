# US-F4-DOC-03: Contratos de Eventos e Comandos (AsyncAPI)

**User Story:** Como Desenvolvedor de qualquer um dos servicos, quero um catalogo versionado de todos os eventos e comandos trocados pelo broker, para implementar produtores e consumidores sem depender de conversas informais.

**Prioridade:** Alta
**Story Points:** 3
**Status:** Em revisão
**DDD Domain:** Todos (integracao)
**DDD Layer:** Documentacao + contratos (`docs/contratos/`)
**Repositorio:** 4 — hub de documentacao

## Contexto

Em microsservicos o contrato e a mensagem. Cada evento/comando tem dono,
schema JSON, semantica e versao. O catalogo e a fonte para os testes de
contrato ([US-F4-15](f4-15-testes-de-contrato.md)).

## Criterios de Aceite

- [x] Arquivo `docs/contratos/asyncapi.yaml` (AsyncAPI 3) com canais, mensagens e schemas JSON
- [x] **Eventos** (fatos, publicados pelo dono): `os.aberta`, `os.cancelada`, `os.finalizada`, `os.entregue`, `execucao.enfileirada`, `execucao.diagnostico-concluido` (itens com preco congelado), `execucao.iniciada`, `execucao.finalizada`, `execucao.reservas-liberadas`, `billing.orcamento-gerado`, `billing.orcamento-aprovado`, `billing.orcamento-rejeitado`, `billing.cobranca-criada`, `billing.pagamento-aprovado`, `billing.pagamento-recusado`, `billing.orcamento-cancelado`
- [x] **Comandos** (ordens do orquestrador): `execucao.enfileirar`, `execucao.iniciar`, `execucao.liberar-reservas`, `billing.gerar-orcamento`, `billing.cancelar-orcamento`
- [x] Envelope comum documentado (ver ADR-0009) e regra de versionamento (campo `version`, mudancas compativeis vs incompativeis)
- [x] Tabela evento -> produtor -> consumidores -> fila SQS -> DLQ
- [ ] Renderizacao HTML do AsyncAPI publicada no README do hub — PENDENTE: entra com o workflow do hub na Onda 1 (comando documentado em docs/contratos/README.md)
## Dependencias

- [US-F4-DOC-01](f4-doc-01-rfcs.md), [US-F4-DOC-02](f4-doc-02-adrs.md)
