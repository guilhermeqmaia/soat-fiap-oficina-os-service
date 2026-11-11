# US-F4-14: BDD dos Fluxos da OS (Gherkin + Cucumber) — exigencia do professor

**User Story:** Como Product Owner, quero cada fluxo do diagrama da OS descrito em Gherkin e executado automaticamente com Cucumber em cada servico e ponta a ponta contra os tres servicos, para validar o comportamento de negocio na linguagem do dominio, como o professor exige.

**Prioridade:** Alta
**Story Points:** 8
**Status:** Em andamento (reescrita em 03/11/2026: Gherkin + Cucumber obrigatorios; um `.feature` por fluxo em cada servico + ponta a ponta no hub; sem LocalStack)
**DDD Domain:** Todos (fluxo distribuido)
**DDD Layer:** Testes (BDD)
**Repositorio:** 4 — hub (`e2e/` com compose de todos os servicos) + os-service, billing-service, execucao-service (`features/` em cada um)

## Contexto

Enunciado: "pelo menos um fluxo completo testado com BDD". **Exigencia do
professor (03/11):** os testes BDD devem ser escritos em **Gherkin** e executados
com **Cucumber** (`@cucumber/cucumber`, `# language: pt`), e cada fluxo do diagrama
da OS deve ter o seu `.feature`. Dois niveis:

1. **Por servico** (`features/` em cada repo, roda no CI do servico com o banco local
   e os outros servicos mockados por HTTP): cobre os fluxos que o servico possui.
2. **Ponta a ponta** (`e2e/features/` no hub, roda num `docker-compose.fase4.yml` com
   os tres servicos, 2 Postgres, DynamoDB Local, mock do Mercado Pago e a Lambda local
   — **sem LocalStack**, RFC-0008): cobre o fluxo completo e as compensacoes.

## Criterios de Aceite

- [ ] `@cucumber/cucumber` + `ts-node` configurados nos tres servicos e no hub (`npm run test:bdd`); Gherkin em portugues (`# language: pt`), steps em TypeScript reutilizando `mintToken`/`mintServiceToken` do kit
- [ ] **Um `.feature` por fluxo do diagrama da OS**, com pelo menos os cenarios:
  - `abrir-os.feature` (OS Service): atendente abre OS -> `RECEBIDA` -> Execucao enfileira -> `EM_DIAGNOSTICO`; veiculo ja em execucao -> `CANCELADA` (`EXECUCAO_RECUSADA`)
  - `diagnostico.feature` (Execucao): mecanico vincula servicos e pecas e conclui o diagnostico -> baixa de estoque -> callback `execucao.diagnostico-concluido`; estoque insuficiente -> `409 { motivo }` e nada e baixado
  - `orcamento.feature` (Billing): orcamento gerado a partir dos itens com precos congelados; validade; orcamento duplicado devolve o existente
  - `aprovacao.feature` (Billing + OS): cliente aprova -> callback -> `EM_EXECUCAO` (Execucao inicia e baixa o estoque); cliente rejeita -> `CANCELADA` com reservas liberadas
  - `execucao.feature` (Execucao): iniciar baixa o estoque; concluir servicos; finalizar -> callback `execucao.finalizada`
  - `cobranca.feature` (Billing + OS): `execucao.finalizada` -> `AGUARDANDO_PAGAMENTO` -> `POST /orcamentos/{n}/cobrar` cria a order -> `billing.cobranca-criada` com `linkPagamento` -> notificacao ao cliente
  - `pagamento.feature` (Billing + OS): webhook `order.processed` aprovado -> `billing.pagamento-aprovado` -> `FINALIZADA`; recusado -> OS permanece `AGUARDANDO_PAGAMENTO` e `reprocessar` emite nova cobranca; webhook com assinatura invalida -> ignorado
  - `entrega.feature` (OS Service): atendente entrega -> `ENTREGUE`; entregar sem pagamento -> recusado
  - `rejeicao.feature` (OS + Execucao + Billing): orcamento rejeitado -> `DELETE /execucao/ordens/{n}` -> OS `CANCELADA` (`ORCAMENTO_REJEITADO`)
  - `cancelamento.feature` (OS + Execucao + Billing): atendente cancela em cada passo ate `INICIAR_EXECUCAO` -> compensacoes certas; cancelar apos a execucao comecar -> recusado; timeout de aprovacao -> `TIMEOUT_APROVACAO`
- [ ] **Ponta a ponta no hub** (`e2e/features/ordem-de-servico-completa.feature`): cenario feliz completo (abrir -> diagnostico -> orcamento -> aprovar -> executar -> finalizar -> cobrar -> pagar -> entregar) verificando o status em cada servico e a linha do tempo da saga; cenario de rejeicao com compensacao; cenario de **idempotencia** (callback reenviado com o mesmo `id` nao duplica efeito; `POST /execucao/ordens` repetido nao duplica fila)
- [ ] Nos `.feature` por servico, os outros servicos sao **mocks HTTP** (WireMock no compose ou nock nos steps) respondendo conforme `http-interno.md`; no ponta a ponta, sao os servicos reais
- [ ] Espera por callbacks com polling e timeout (`GET .../saga`, `GET .../status`); nenhum `sleep` fixo
- [ ] Executado no CI de cada servico (`bdd` job) e no hub (`bdd.yml`) a cada PR dos servicos via `repository_dispatch` e nightly
- [ ] Relatorio HTML do Cucumber publicado como artifact em cada repo e linkado no README; o PDF da entrega referencia os `.feature`

## O que salva no banco

Nao se aplica (historia de testes). Os cenarios usam os bancos reais de cada servico no compose (recriados por seed a cada execucao) e verificam o estado via API, nunca por acesso direto ao banco de outro servico.

## Dependencias

- [US-F4-18](f4-18-comunicacao-http-entre-servicos.md) (compose sem LocalStack, contrato HTTP), [US-F4-10](f4-10-saga-orquestrada.md), [US-F4-11](f4-11-compensacoes-rollback.md), [US-F4-07](f4-07-execucao-service.md), [US-F4-08](f4-08-billing-orcamento.md), [US-F4-09](f4-09-billing-mercado-pago.md)
