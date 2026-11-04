# US-F4-12: Notificacoes ao Cliente a partir dos Eventos

**User Story:** Como Cliente, quero continuar sendo avisado quando o orcamento ficar pronto, o pagamento for confirmado e a OS for finalizada, para acompanhar minha OS mesmo com o sistema distribuido.

**Prioridade:** Media
**Story Points:** 3
**Status:** To Do
**DDD Domain:** Notificacao
**DDD Layer:** Application (consumidor de eventos) + Infrastructure
**Repositorio:** OS Service (modulo `notificacao`)

## Contexto

O modulo de Notificacao da Fase 2 ja e um consumidor de eventos — so muda a
fonte: filas SQS em vez do `EventEmitter`. Um bom exemplo de coreografia dentro
de uma arquitetura orquestrada: a notificacao apenas assina fatos.

## Criterios de Aceite

- [ ] Fila `notificacao` assinando `billing.orcamento-gerado`, `billing.orcamento-aprovado`, `billing.cobranca-criada`, `billing.pagamento-aprovado`, `billing.pagamento-recusado`, `os.finalizada`, `os.cancelada`
- [ ] Mensagens com o **link de pagamento** quando houver — o link vem em `billing.cobranca-criada` (cobranca criada apos a execucao, ADR-0012), nao em `billing.orcamento-aprovado`
- [ ] Canais mantidos: webhook (HMAC) e e-mail; `GET /clientes/:cpf/notificacoes` inalterado
- [ ] Consumidor idempotente (uma notificacao por `messageId`)
## Dependencias

- [US-F4-06](f4-06-os-service-strangler.md)

## Atencao (review da US-F4-06/10, 21/10)

O OS Service ainda notifica **in-process** (`OrdemDeServicoNotificacaoListener`: `OrcamentoProntoEvent`,
`OsFinalizadaEvent`, `OsStatusAlteradoEvent`) e a fila `notificacao-eventos` ja assina
`billing.orcamento-gerado`/`orcamento-aprovado`/`cobranca-criada`/`pagamento-aprovado`/`pagamento-recusado` e `os.*`.
Ao ligar o consumidor da fila, **remover (ou desligar por flag) as notificacoes in-process** para o cliente nao
receber dois e-mails pelo mesmo fato — e enviar o `linkPagamento` de `billing.cobranca-criada` na mensagem
"servico concluido, pague para retirar o veiculo" (a mensagem de orcamento aprovado nao tem link).
