# Stubs dos participantes (Billing e Execução)

Usados pelo `docker-compose.fase4.yml` enquanto o Billing (`feat/fluxo-2-billing`) e a
Execução (endpoints de domínio) não estão prontos. Uma imagem, dois containers:
`billing-service:3001` e `execucao-service:3002`. Para usar as imagens reais, defina
`BILLING_IMAGE` / `EXECUCAO_IMAGE` (ver o roteiro em
[`docs/fluxo-3/teste-manual-ponta-a-ponta.md`](../../docs/fluxo-3/teste-manual-ponta-a-ponta.md)).

## O que seguem

Os endpoints `SERVICO` de [`docs/contratos/http-interno.md`](../../docs/contratos/http-interno.md),
com os mesmos códigos, idempotentes por `numeroOS`, validando o JWT `SERVICO` com o mesmo
`JWT_SECRET`. A cada requisição do contrato o stub confere contra
[`docs/contratos/schemas/`](../../docs/contratos/schemas/):

- o **corpo recebido** do OS Service (`comandos.schema.json`) — fora do contrato → `400` + violação;
- a **resposta devolvida** (`endpoints-participantes.json`: status declarado + schema);
- o **envelope do callback** enviado (`callbacks.schema.json`).

Violações saem no log como `CONTRATO VIOLADO` e em `GET /__stub/violacoes`; o BDD ponta a
ponta falha se houver alguma no fim do cenário.

| Serviço | Contrato (role `SERVICO`) | Ações que geram callback |
|---|---|---|
| Execução | `POST /execucao/ordens`, `POST /execucao/ordens/{n}/iniciar`, `DELETE /execucao/ordens/{n}` | `POST /execucao/ordens/{n}/diagnostico` (MECANICO) → `execucao.diagnostico-concluido`; `POST /execucao/ordens/{n}/finalizar` → `execucao.finalizada` |
| Billing | `POST /orcamentos`, `POST /orcamentos/{n}/cobrar`, `DELETE /orcamentos/{n}` | `POST /orcamentos/{n}/aprovar` / `rejeitar` (CLIENTE) → `billing.orcamento-aprovado` / `rejeitado`; `POST /__stub/pagamentos/{n}` (simula o webhook do Mercado Pago) → `billing.pagamento-aprovado` / `recusado` |

Os callbacks usam o `ClienteHttpInterno` do kit (JWT `SERVICO`, `x-correlation-id`, 3
tentativas em 5xx/rede). O `409` do OS é relido e repetido (até 3x). O `traceparent`
recebido na ação é repassado ao callback. A resposta das ações traz `callback: { id, type,
status, body }` com o que o OS respondeu (campo que só existe no stub).

## Controle (só no stub)

| Rota | Para quê |
|---|---|
| `POST /__stub/cenario` `{ pagamento: 'recusado' (só o próximo pagamento), falhar5xx: 3, rota: 'POST /orcamentos', recusar: { rota, motivo }, atrasoMs }` | muda o comportamento dos próximos pedidos (`falhar5xx` decrementa a cada falha; com 3 o retry do OS esgota) |
| `DELETE /__stub/cenario` · `GET /__stub/cenario` | volta ao padrão · consulta |
| `GET /__stub/chamadas?numeroOS=&rota=` · `DELETE /__stub/chamadas` | chamadas recebidas do OS (com `sub`, `x-correlation-id`, `traceparent`, status) |
| `GET /__stub/violacoes` | divergências de contrato |
| `GET /__stub/ordens/{n}` (Execução) · `GET /__stub/orcamentos/{n}` (Billing) | estado do participante |
| `POST /__stub/callbacks/{n}/reenviar` | reenvia o último callback da OS com o **mesmo** `id` |

## Mercado Pago

Não há mock do Mercado Pago: o link é falso (`LINK_PAGAMENTO_BASE`, padrão
`https://mp.test/pay`) e o resultado do pagamento vem de `POST /__stub/pagamentos/{n}`.
Ponto de troca: com o Billing real, o resultado chega pelo webhook `order.processed`
(`POST /webhooks/mercadopago`, assinado) — aponte o `MERCADO_PAGO_BASE_URL` do Billing para
um mock (ex.: WireMock) e dispare o webhook no lugar desta rota.

## Rodar fora do Docker

```bash
cd e2e/stubs && npm ci && npm run build
JWT_SECRET=... OS_SERVICE_URL=http://localhost:3000 PORT=3001 node dist/billing.js
JWT_SECRET=... OS_SERVICE_URL=http://localhost:3000 PORT=3002 node dist/execucao.js
```
