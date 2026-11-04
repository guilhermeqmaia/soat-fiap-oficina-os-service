# US-F4-08: Billing Service — Orcamento, Aprovacao e Rejeicao

**User Story:** Como Cliente, quero receber o orcamento da minha OS e aprova-lo ou rejeita-lo num servico dedicado, para que a decisao dispare o pagamento ou o cancelamento com seguranca.

**Prioridade:** Alta
**Story Points:** 8
**Status:** To Do
**DDD Domain:** Billing (novo: Orcamento, Pagamento)
**DDD Layer:** Domain + Application + Infrastructure
**Repositorio:** novo — `soat-fiap-oficina-billing-service`

## Contexto

Enunciado: "geracao e envio de orcamentos para aprovacao; registro e
verificacao de pagamentos; atualizacao do status da OS apos pagamento". Banco
**SQL (Postgres)** — dinheiro exige ACID e um ledger auditavel (licao do Nubank:
nunca corrigir saldo "so na memoria da maquina").

## Criterios de Aceite

- [ ] Consome `billing.gerar-orcamento` (comando com itens e precos congelados) -> cria `Orcamento` (itens, subtotal, total, validade) -> publica `billing.orcamento-gerado`
- [ ] `GET /orcamentos/:id` e `GET /orcamentos?os=` com posse por CPF (claim) para CLIENTE
- [ ] `POST /orcamentos/:id/aprovar` -> publica `billing.orcamento-aprovado` `{ numeroOS, orcamentoId }` (**sem** cobranca: a order so e criada ao receber `billing.cobrar`, apos a execucao — [US-F4-09](f4-09-billing-mercado-pago.md))
- [ ] `POST /orcamentos/:id/rejeitar` -> publica `billing.orcamento-rejeitado`
- [ ] Consome `billing.cancelar-orcamento` (compensacao, so antes da execucao) -> cancela orcamento -> `billing.orcamento-cancelado` (idempotente; `estornado` sempre false)
- [ ] Orcamento e imutavel apos aprovado; nova versao exige novo diagnostico
- [ ] Tabela `ledger` append-only com todo lancamento (orcamento, cobranca, pagamento)
- [ ] Testes >= 80%; Swagger
## Dependencias

- [US-F4-01](f4-01-kit-compartilhado.md), [US-F4-02](f4-02-mensageria.md), [US-F4-03](f4-03-bancos-por-servico.md)
