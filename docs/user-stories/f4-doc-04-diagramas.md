# US-F4-DOC-04: Diagrama Geral da Arquitetura e Sequencias da Saga

**User Story:** Como Avaliador, quero um diagrama geral com microsservicos, bancos e comunicacao, e diagramas de sequencia da saga (caminho feliz e compensacao), para entender o sistema distribuido sem ler codigo.

**Prioridade:** Alta
**Story Points:** 3
**Status:** To Do
**DDD Domain:** Todos
**DDD Layer:** Documentacao (`docs/arquitetura/`)
**Repositorio:** 4 — hub de documentacao

## Contexto

O PDF de entrega exige o "diagrama geral da arquitetura final com
microsservicos, bancos e comunicacao". Evolui `arquitetura-fase3.md`.

## Criterios de Aceite

- [ ] `docs/arquitetura/arquitetura-fase4.md` com diagrama de componentes (Mermaid): gateway, Lambda, 3 servicos, 2 Postgres + DynamoDB, SNS/SQS, Mercado Pago, observabilidade
- [ ] Diagrama de sequencia do **caminho feliz**: abrir OS -> enfileirar -> diagnostico -> orcamento -> aprovacao + pagamento -> execucao -> finalizacao -> entrega
- [ ] Diagrama de sequencia de **compensacao**: pagamento recusado -> liberar reservas -> cancelar orcamento -> OS CANCELADA
- [ ] Diagrama de sequencia de **timeout**: orcamento sem resposta em N dias
- [ ] Maquina de estados da OS atualizada (novo status `AGUARDANDO_PAGAMENTO`, apos `EM_EXECUCAO` — cobranca apos a execucao) com o servico dono de cada transicao
- [ ] Diagrama de deploy (EKS: 3 deployments, HPA, NLB com 3 listeners, filas)
- [ ] Mesmo diagrama geral reaproveitado no README do hub e no PDF
## Dependencias

- [US-F4-DOC-01](f4-doc-01-rfcs.md)
