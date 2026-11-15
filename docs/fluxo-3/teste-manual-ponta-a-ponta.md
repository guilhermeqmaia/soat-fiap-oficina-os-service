# FLUXO 3 — roteiro de teste manual ponta a ponta (US-F4-14)

Executa à mão, com `curl`, o ciclo da OS entre **OS Service**, **Execução** e **Billing** no
`docker-compose.fase4.yml`, e mostra o que conferir em cada passo: status da OS, saga, estado do
participante, e-mail no Mailpit, logs com o mesmo `correlation_id` e métricas. O mesmo fluxo é
automatizado em [`features/e2e/ciclo-completo-os.feature`](../../features/e2e/ciclo-completo-os.feature)
(`npm run test:bdd:e2e`).

**Evidência**: todas as saídas abaixo são reais, coladas da execução de **11/11/2026** (branch
`test/f4-14-bdd-ponta-a-ponta`, ambiente recriado do zero com `npm run e2e:down && npm run e2e:up`,
Billing e Execução = stubs de [`e2e/stubs`](../../e2e/stubs/README.md)). Algumas saídas passam por
um filtro `campo` (abaixo) para mostrar só os campos que interessam; as consultas repetidas da
seção 2 (status, saga, e-mails) e o corpo do diagnóstico aparecem abreviados como `campo '(...)'`
/ `...` depois da primeira vez, e os objetos do Node foram compactados em menos linhas.

## 1. Subir o ambiente

Pré-requisitos: Docker (Compose v2), Node 20+, `npm ci` na raiz.

```bash
npm run e2e:up        # docker compose -f docker-compose.fase4.yml up -d --build --wait
```

| Serviço | URL no host | DNS interno | Observação |
|---|---|---|---|
| os-service | http://localhost:3000 (Swagger em `/api`) | `os-service:3000` | build local; Postgres `oficina_os` |
| billing-service | http://localhost:3001 | `billing-service:3001` | stub (ou `BILLING_IMAGE`) |
| execucao-service | http://localhost:3002 | `execucao-service:3002` | stub (ou `EXECUCAO_IMAGE`) |
| Mailpit | http://localhost:8025 (UI e API) | `mailpit:1025` (SMTP) | recebe os e-mails do OS Service |

Os três serviços usam o mesmo `JWT_SECRET` (default do compose:
`e2e-fase4-jwt-secret-0123456789abcdef-local`) e as variáveis `OS_SERVICE_URL`,
`BILLING_SERVICE_URL`, `EXECUCAO_SERVICE_URL` apontando para o DNS interno.

### Variáveis e helpers da sessão (bash)

```bash
OS=http://localhost:3000 BILL=http://localhost:3001 EXEC=http://localhost:3002 MAIL=http://localhost:8025
J='content-type: application/json'
# extrai campos do JSON sem depender de jq
campo() { node -pe "const o=JSON.parse(require('fs').readFileSync(0));$1"; }

# tokens com o mesmo contrato da Lambda (mintToken/mintServiceToken do kit)
ADM=$(npm run -s e2e:token -- admin); ATD=$(npm run -s e2e:token -- atendente); MEC=$(npm run -s e2e:token -- mecanico)
CPF=52998224725; CLI=$(npm run -s e2e:token -- cliente $CPF)
```

> `npm run -s e2e:token -- os-service|billing-service|execucao-service` emite o JWT `SERVICO`
> (útil para chamar os endpoints internos à mão, ex.: `POST $EXEC/execucao/ordens`).

## 2. Dados de base (mecânico, cliente, veículo)

```bash
$ MID=$(curl -s -XPOST $OS/usuario -H "Authorization: Bearer $ADM" -H "$J" -d '{"nome":"Carlos Mecanico","email":"carlos.'$RANDOM'@oficina.test","senha":"segredo123","role":"MECANICO"}' | campo o.id); echo MID=$MID
MID=17cb7358-793d-4c1d-85e8-a54c07b6cf54

$ CID=$(curl -s -XPOST $OS/clientes -H "Authorization: Bearer $ADM" -H "$J" -d '{"nome":"Maria Souza","cpfCnpj":"'$CPF'","telefone":"11999990000","email":"maria.souza@cliente.test"}' | campo o.id); echo CID=$CID
CID=efa45cc5-4d69-41cb-bd6d-d5238e878441
```

Para cada cenário, crie um veículo novo (placa Mercosul válida e única — a Execução recusa um
veículo que já está em execução) e abra a OS:

```bash
PLACA=QWE1R23   # troque a cada cenário
VID=$(curl -s -XPOST $OS/veiculos -H "Authorization: Bearer $ADM" -H "$J" -d '{"placa":"'$PLACA'","marca":"Toyota","modelo":"Corolla","ano":2024,"clienteId":"'$CID'"}' | campo o.id)
R=$(curl -s -XPOST $OS/ordens-servico -H "Authorization: Bearer $ATD" -H "$J" -d '{"clienteId":"'$CID'","veiculoId":"'$VID'","descricaoInicial":"Barulho ao frear"}')
N=$(echo "$R" | campo o.numero); OID=$(echo "$R" | campo o.id)   # N = numero (callbacks, status, saga); OID = id (cancelar/entregar)
```

Consultas usadas em todos os cenários:

```bash
# status publico da OS
curl -s $OS/ordens-servico/numero/$N/status | campo '({status:o.status,motivoCancelamento:o.motivoCancelamento,valorTotal:o.valorTotal})'
# saga (passo, compensacoes, ultimas 3 entradas do historico)
curl -s $OS/ordens-servico/numero/$N/saga -H "Authorization: Bearer $ATD" | campo '({passo:o.passo,status:o.status,compensacoes:o.compensacoes.map(c=>c.comando+(c.confirmadaEm?" (confirmada)":"")),ultimos:o.historico.slice(-3).map(h=>h.evento+" -> "+h.resultado+(h.detalhe?" ["+h.detalhe+"]":""))})'
# e-mails da OS no Mailpit (tambem visiveis na UI http://localhost:8025)
curl -s "$MAIL/api/v1/search?query=$N" | campo 'o.messages.map(m=>m.Created.slice(11,19)+" "+m.To[0].Address+" | "+m.Subject).reverse().join("\n")'
```

> A saga é consultada em `GET /ordens-servico/numero/{numero}/saga` (ATENDENTE/ADMIN). Não existe
> `GET /admin/sagas/:numero`: em `/admin/sagas` há só `POST /admin/sagas/:numero/reprocessar`.

As **ações de pessoa** acontecem no serviço dono delas, que então envia o callback
`POST /ordens-servico/{n}/eventos` ao OS (JWT `SERVICO`, `x-correlation-id` = número da OS). A
resposta das ações do stub traz `callback` com o que o OS respondeu:

| Ação | Comando | Callback gerado |
|---|---|---|
| Mecânico diagnostica | `POST $EXEC/execucao/ordens/$N/diagnostico` (MECANICO) | `execucao.diagnostico-concluido` |
| Cliente aprova / rejeita | `POST $BILL/orcamentos/$N/aprovar` · `/rejeitar` (CLIENTE) | `billing.orcamento-aprovado` / `-rejeitado` |
| Mecânico finaliza | `POST $EXEC/execucao/ordens/$N/finalizar` (MECANICO) | `execucao.finalizada` |
| Mercado Pago processa | `POST $BILL/__stub/pagamentos/$N` (só no stub) | `billing.pagamento-aprovado` / `-recusado` |

## 3. Caminho feliz (até ENTREGUE)

**3.1 Abrir a OS** → OS chama `POST /execucao/ordens` → `201` ≙ `execucao.enfileirada` → `EM_DIAGNOSTICO`.

```bash
$ echo "$R" | campo '({numero:o.numero,status:o.status})'
{ numero: 'OS-2026-4440732159-4551', status: 'EM_DIAGNOSTICO' }

$ curl -s "$EXEC/__stub/chamadas?numeroOS=$N" | campo 'o.map(c=>c.rota+" -> "+c.status+" sub="+c.sub+" x-correlation-id="+c.headers["x-correlation-id"])'
[ 'POST /execucao/ordens -> 201 sub=os-service x-correlation-id=OS-2026-4440732159-4551' ]
```

Conferir: status `EM_DIAGNOSTICO`; a Execução recebeu a chamada com o JWT de serviço do OS
(`sub=os-service`) e `x-correlation-id` = número da OS; e-mail "Status da OS …: EM_DIAGNOSTICO".

**3.2 Mecânico diagnostica** → callback → OS chama `POST /orcamentos` → `AGUARDANDO_APROVACAO`.

```bash
$ curl -s -XPOST $EXEC/execucao/ordens/$N/diagnostico -H "Authorization: Bearer $MEC" -H "$J" -d '{"mecanicoId":"'$MID'","diagnostico":"Pastilhas gastas","itens":[{"tipo":"SERVICO","referenciaId":"srv-1","nome":"Troca de pastilha","quantidade":1,"precoUnitario":"200.00"},{"tipo":"PRODUTO","referenciaId":"prd-1","nome":"Pastilha","quantidade":2,"precoUnitario":"50.00","servicoId":"srv-1"}]}' | campo '({estado:o.estado.status,callback:o.callback})'
{
  estado: 'DIAGNOSTICADA',
  callback: { id: '01a1cd00-9ff3-723b-bfd3-6a5333b55d4c', type: 'execucao.diagnostico-concluido', status: 200,
    body: { aplicado: true, passo: 'AGUARDAR_APROVACAO', status: 'EM_ANDAMENTO' }, repeticoes409: 0 }
}

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'AGUARDANDO_APROVACAO', motivoCancelamento: null, valorTotal: 300 }
```

Conferir: callback `aplicado: true`; OS `AGUARDANDO_APROVACAO` com total R$ 300 (200 + 2 × 50);
e-mail "Orcamento da OS … pronto para aprovacao".

**3.3 Cliente aprova** → callback → OS chama `POST /execucao/ordens/{n}/iniciar` → `EM_EXECUCAO`.

```bash
$ curl -s -XPOST $BILL/orcamentos/$N/aprovar -H "Authorization: Bearer $CLI" | campo '({estado:o.estado.status,callback:o.callback})'
{
  estado: 'APROVADO',
  callback: { id: '01a1cd00-a12a-76ab-a7fe-ca8b3ac1a3b1', type: 'billing.orcamento-aprovado', status: 200,
    body: { aplicado: true, passo: 'AGUARDAR_FINALIZACAO', status: 'EM_ANDAMENTO' }, repeticoes409: 0 }
}

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'EM_EXECUCAO', motivoCancelamento: null, valorTotal: 300 }
```

**3.4 Mecânico finaliza** → callback → `AGUARDANDO_PAGAMENTO` + `POST /orcamentos/{n}/cobrar` (link de pagamento).

```bash
$ curl -s -XPOST $EXEC/execucao/ordens/$N/finalizar -H "Authorization: Bearer $MEC" | campo '({estado:o.estado.status,callback:o.callback})'
{
  estado: 'FINALIZADA',
  callback: { id: '01a1cd00-a231-76df-80b1-c64131a38313', type: 'execucao.finalizada', status: 200,
    body: { aplicado: true, passo: 'AGUARDAR_PAGAMENTO', status: 'EM_ANDAMENTO' }, repeticoes409: 0 }
}

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'AGUARDANDO_PAGAMENTO', motivoCancelamento: null, valorTotal: 300 }

$ curl -s $BILL/__stub/orcamentos/$N | campo 'o.cobrancas'
[ { orderId: 'mp-17944407332531', linkPagamento: 'https://mp.test/pay/mp-17944407332531', valor: '300.00',
    status: 'PENDENTE', criadaEm: '2026-11-11T23:45:33.253Z' } ]
```

Conferir: e-mail "OS … concluida - pague para retirar o veiculo" com o **mesmo** link da cobrança
(abra no Mailpit; o link é falso — não há mock do Mercado Pago).

**3.5 Mercado Pago aprova** → callback `billing.pagamento-aprovado` → `FINALIZADA`, saga `CONCLUIDA`.

```bash
$ curl -s -XPOST $BILL/__stub/pagamentos/$N -H "$J" -d '{}' | campo '({estado:o.estado.status,callback:o.callback})'
{
  estado: 'PAGO',
  callback: { id: '01a1cd00-a308-75cd-9982-1272b1487c03', type: 'billing.pagamento-aprovado', status: 200,
    body: { aplicado: true, passo: 'CONCLUIDA', status: 'CONCLUIDA' }, repeticoes409: 0 }
}

$ curl -s $OS/ordens-servico/numero/$N/saga -H "Authorization: Bearer $ATD" | campo '(...)'
{
  passo: 'CONCLUIDA', status: 'CONCLUIDA', compensacoes: [],
  ultimos: [
    'execucao.finalizada -> avancou [AGUARDAR_FINALIZACAO -> COBRAR]',
    'billing.cobranca-criada -> avancou [COBRAR -> AGUARDAR_PAGAMENTO]',
    'billing.pagamento-aprovado -> concluida'
  ]
}
```

**3.6 Atendente entrega** → `ENTREGUE`.

```bash
$ curl -s -XPOST $OS/ordens-servico/$OID/entregar -H "Authorization: Bearer $ATD" -o /dev/null -w 'HTTP %{http_code}\n'
HTTP 200

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'ENTREGUE', motivoCancelamento: null, valorTotal: 300 }
```

**3.7 E-mails, notificações, logs e métricas do caminho feliz**

```bash
$ curl -s "$MAIL/api/v1/search?query=$N" | campo '...'
23:45:32 maria.souza@cliente.test | Status da OS OS-2026-4440732159-4551: EM_DIAGNOSTICO
23:45:32 maria.souza@cliente.test | Orcamento da OS OS-2026-4440732159-4551 pronto para aprovacao
23:45:33 maria.souza@cliente.test | Orcamento da OS OS-2026-4440732159-4551 aprovado
23:45:33 maria.souza@cliente.test | Status da OS OS-2026-4440732159-4551: EM_EXECUCAO
23:45:33 maria.souza@cliente.test | OS OS-2026-4440732159-4551 concluida - pague para retirar o veiculo
23:45:33 maria.souza@cliente.test | Pagamento da OS OS-2026-4440732159-4551 confirmado
23:45:33 maria.souza@cliente.test | OS OS-2026-4440732159-4551 finalizada - veiculo pronto para retirada
23:45:33 maria.souza@cliente.test | Status da OS OS-2026-4440732159-4551: ENTREGUE

$ curl -s "$OS/notificacoes?ordemDeServicoId=$OID&limit=20" -H "Authorization: Bearer $ATD" | campo 'o.data.map(n=>n.tipo+" "+n.canal+" "+n.destinatario+(n.linkPagamento?" "+n.linkPagamento:"")).join("\n")'
STATUS_OS_ALTERADO EMAIL maria.souza@cliente.test
PAGAMENTO_APROVADO EMAIL maria.souza@cliente.test
OS_FINALIZADA EMAIL maria.souza@cliente.test
PAGAMENTO_PENDENTE EMAIL maria.souza@cliente.test https://mp.test/pay/mp-17944407332531
STATUS_OS_ALTERADO EMAIL maria.souza@cliente.test
ORCAMENTO_APROVADO EMAIL maria.souza@cliente.test
ORCAMENTO_PRONTO EMAIL maria.souza@cliente.test
STATUS_OS_ALTERADO EMAIL maria.souza@cliente.test
```

Logs dos **três** serviços com o mesmo `correlation_id` (= número da OS):

```bash
$ docker compose -f docker-compose.fase4.yml logs --no-log-prefix os-service billing-service execucao-service \
    | grep -h "\"correlation_id\":\"$N\"" \
    | node -e 'require("readline").createInterface({input:process.stdin}).on("line",l=>{try{const o=JSON.parse(l);console.log([o.servico,o.msg,o.rota??"",o.status??o.statusCode??""].join(" | "))}catch{}})' | head -25
execucao-service | POST /execucao/ordens -> 201 | POST /execucao/ordens | 201
execucao-service | callback entregue | POST /ordens-servico/{numero}/eventos | 200
execucao-service | POST /execucao/ordens/{n}/diagnostico -> 200 | POST /execucao/ordens/{n}/diagnostico | 200
billing-service | POST /orcamentos -> 201 | POST /orcamentos | 201
billing-service | callback entregue | POST /ordens-servico/{numero}/eventos | 200
billing-service | POST /orcamentos/{n}/aprovar -> 200 | POST /orcamentos/{n}/aprovar | 200
billing-service | POST /orcamentos/{n}/cobrar -> 201 | POST /orcamentos/{n}/cobrar | 201
billing-service | callback entregue | POST /ordens-servico/{numero}/eventos | 200
execucao-service | POST /execucao/ordens/{n}/iniciar -> 200 | POST /execucao/ordens/{n}/iniciar | 200
execucao-service | callback entregue | POST /ordens-servico/{numero}/eventos | 200
execucao-service | POST /execucao/ordens/{n}/finalizar -> 200 | POST /execucao/ordens/{n}/finalizar | 200
os-service | comando executado | POST /execucao/ordens | 201
os-service | saga avancou |  | EM_ANDAMENTO
os-service | saga avancou |  | EM_ANDAMENTO
os-service | comando executado | POST /orcamentos | 201
os-service | saga avancou |  | EM_ANDAMENTO
os-service | callback recebido | POST /ordens-servico/{numero}/eventos |
os-service | saga avancou |  | EM_ANDAMENTO
os-service | comando executado | POST /execucao/ordens/{numero}/iniciar | 200
os-service | saga avancou |  | EM_ANDAMENTO
os-service | callback recebido | POST /ordens-servico/{numero}/eventos |
os-service | saga avancou |  | EM_ANDAMENTO
os-service | comando executado | POST /orcamentos/{numero}/cobrar | 201
os-service | saga avancou |  | EM_ANDAMENTO
os-service | callback recebido | POST /ordens-servico/{numero}/eventos |
```

(O `docker compose logs` agrupa por serviço; a ordem cronológica está no campo `time` de cada linha.
Sem APM ligado não há `traceparent` — ver "Limitações".)

Métricas novas (ambiente recém-criado, só esta OS):

```bash
$ curl -s $OS/metrics | grep -E '^oficina_(callbacks_total|http_interno_total)' | grep -v ' 0$'
oficina_http_interno_total{origem="os-service",destino="execucao-service",rota="POST /execucao/ordens",resultado="sucesso",service="os-service"} 1
oficina_http_interno_total{origem="os-service",destino="execucao-service",rota="POST /execucao/ordens/{numero}/iniciar",resultado="sucesso",service="os-service"} 1
oficina_http_interno_total{origem="os-service",destino="billing-service",rota="POST /orcamentos",resultado="sucesso",service="os-service"} 1
oficina_http_interno_total{origem="os-service",destino="billing-service",rota="POST /orcamentos/{numero}/cobrar",resultado="sucesso",service="os-service"} 1
oficina_callbacks_total{type="execucao.diagnostico-concluido",resultado="aplicado",service="os-service"} 1
oficina_callbacks_total{type="execucao.finalizada",resultado="aplicado",service="os-service"} 1
oficina_callbacks_total{type="billing.orcamento-aprovado",resultado="aplicado",service="os-service"} 1
oficina_callbacks_total{type="billing.pagamento-aprovado",resultado="aplicado",service="os-service"} 1
```

Conferir: 4 chamadas internas com `resultado="sucesso"` (enfileirar, gerar orçamento, iniciar,
cobrar) e 4 callbacks `aplicado`.

## 4. Rejeição do orçamento (compensação)

OS nova em `AGUARDANDO_APROVACAO` (passos 3.1 e 3.2) e o cliente rejeita:

```bash
$ curl -s -XPOST $BILL/orcamentos/$N/rejeitar -H "Authorization: Bearer $CLI" -H "$J" -d '{"motivo":"achei caro"}' | campo '({estado:o.estado.status,callback:o.callback})'
{
  estado: 'REJEITADO',
  callback: { id: '01a1cd00-a889-73bf-8cc7-c3472d69458d', type: 'billing.orcamento-rejeitado', status: 200,
    body: { aplicado: true, passo: 'AGUARDAR_APROVACAO', status: 'CANCELADA' }, repeticoes409: 0 }
}

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'CANCELADA', motivoCancelamento: 'ORCAMENTO_REJEITADO', valorTotal: 300 }

$ curl -s $OS/ordens-servico/numero/$N/saga -H "Authorization: Bearer $ATD" | campo '(...)'
{
  passo: 'AGUARDAR_APROVACAO', status: 'CANCELADA',
  compensacoes: [ 'execucao.liberar-reservas (confirmada)' ],
  ultimos: [
    'billing.orcamento-gerado -> avancou [GERAR_ORCAMENTO -> AGUARDAR_APROVACAO]',
    'billing.orcamento-rejeitado -> compensando [ORCAMENTO_REJEITADO: execucao.liberar-reservas]',
    'execucao.reservas-liberadas -> cancelada [todas as compensacoes confirmadas]'
  ]
}

$ curl -s $EXEC/__stub/ordens/$N | campo '({status:o.status,motivoLiberacao:o.motivoLiberacao,reservas:o.reservas.length})'
{ status: 'LIBERADA', motivoLiberacao: 'OS cancelada (compensacao da saga)', reservas: 0 }

$ curl -s "$MAIL/api/v1/search?query=$N" | campo '...'
23:45:34 maria.souza@cliente.test | Status da OS OS-2026-4440734394-2495: EM_DIAGNOSTICO
23:45:34 maria.souza@cliente.test | Orcamento da OS OS-2026-4440734394-2495 pronto para aprovacao
23:45:34 maria.souza@cliente.test | OS OS-2026-4440734394-2495 cancelada
```

Conferir: OS `CANCELADA` / `ORCAMENTO_REJEITADO`; uma compensação (`DELETE /execucao/ordens/{n}`)
confirmada; Execução com as reservas devolvidas; **nenhum** `POST …/iniciar`; e-mail "cancelada".
Métricas: `oficina_callbacks_total{type="billing.orcamento-rejeitado",resultado="aplicado"}` e
`oficina_http_interno_total{rota="DELETE /execucao/ordens/{numero}",resultado="sucesso"}` +1.

## 5. Pagamento recusado (sem rollback) + nova cobrança

OS nova em `AGUARDANDO_PAGAMENTO` (3.1 a 3.4). O cenário do stub recusa o **próximo** pagamento:

```bash
$ curl -s -XPOST $BILL/__stub/cenario -H "$J" -d '{"pagamento":"recusado"}' | campo '({pagamento:o.pagamento})'
{ pagamento: 'recusado' }

$ curl -s -XPOST $BILL/__stub/pagamentos/$N -H "$J" -d '{}' | campo '({estado:o.estado.status,callback:o.callback})'
{
  estado: 'APROVADO',
  callback: { id: '01a1cd00-ad06-7158-9d46-c9e52c2e9bb9', type: 'billing.pagamento-recusado', status: 200,
    body: { aplicado: true, passo: 'AGUARDAR_PAGAMENTO', status: 'EM_ANDAMENTO' }, repeticoes409: 0 }
}

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'AGUARDANDO_PAGAMENTO', motivoCancelamento: null, valorTotal: 300 }

$ curl -s $OS/ordens-servico/numero/$N/saga -H "Authorization: Bearer $ATD" | campo '(...)'
{
  passo: 'AGUARDAR_PAGAMENTO', status: 'EM_ANDAMENTO', compensacoes: [],
  ultimos: [
    'execucao.finalizada -> avancou [AGUARDAR_FINALIZACAO -> COBRAR]',
    'billing.cobranca-criada -> avancou [COBRAR -> AGUARDAR_PAGAMENTO]',
    'billing.pagamento-recusado -> pagamento-pendente [pagamento recusado: cartao recusado]'
  ]
}
```

Depois da execução não se cancela (o cliente deve o serviço feito):

```bash
$ curl -s -XPOST $OS/ordens-servico/$OID/cancelar -H "Authorization: Bearer $ATD" -H "$J" -d '{}' | campo '({statusCode:o.statusCode,message:o.message})'
{ statusCode: 400, message: "Transicao invalida de status: nao e possivel ir de 'AGUARDANDO_PAGAMENTO' para 'CANCELADA'" }
```

O reprocessamento emite **nova cobrança** (novo link, novo e-mail) e o pagamento seguinte é aprovado:

```bash
$ curl -s -XPOST $OS/admin/sagas/$N/reprocessar -H "Authorization: Bearer $ADM" | campo '({reenviados:o.reenviados,passo:o.saga.passo,status:o.saga.status})'
{ reenviados: [ 'billing.cobrar' ], passo: 'AGUARDAR_PAGAMENTO', status: 'EM_ANDAMENTO' }

$ curl -s $BILL/__stub/orcamentos/$N | campo 'o.cobrancas.map(c=>c.orderId+" "+c.status+" "+c.linkPagamento)'
[
  'mp-17944407358102 RECUSADA https://mp.test/pay/mp-17944407358102',
  'mp-17944407363243 PENDENTE https://mp.test/pay/mp-17944407363243'
]

$ curl -s -XPOST $BILL/__stub/pagamentos/$N -H "$J" -d '{}' | campo '({estado:o.estado.status,callback:o.callback})'
{
  estado: 'PAGO',
  callback: { id: '01a1cd00-aec6-7580-90dc-15ae1e5e4037', type: 'billing.pagamento-aprovado', status: 200,
    body: { aplicado: true, passo: 'CONCLUIDA', status: 'CONCLUIDA' }, repeticoes409: 0 }
}

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'FINALIZADA', motivoCancelamento: null, valorTotal: 300 }

$ curl -s "$MAIL/api/v1/search?query=$N" | campo '...'
23:45:35 maria.souza@cliente.test | Status da OS OS-2026-4440735354-3775: EM_DIAGNOSTICO
23:45:35 maria.souza@cliente.test | Orcamento da OS OS-2026-4440735354-3775 pronto para aprovacao
23:45:35 maria.souza@cliente.test | Orcamento da OS OS-2026-4440735354-3775 aprovado
23:45:35 maria.souza@cliente.test | Status da OS OS-2026-4440735354-3775: EM_EXECUCAO
23:45:35 maria.souza@cliente.test | OS OS-2026-4440735354-3775 concluida - pague para retirar o veiculo
23:45:36 maria.souza@cliente.test | Pagamento da OS OS-2026-4440735354-3775 recusado
23:45:36 maria.souza@cliente.test | OS OS-2026-4440735354-3775 concluida - pague para retirar o veiculo
23:45:36 maria.souza@cliente.test | Pagamento da OS OS-2026-4440735354-3775 confirmado
23:45:36 maria.souza@cliente.test | OS OS-2026-4440735354-3775 finalizada - veiculo pronto para retirada
```

Conferir: a OS **fica** em `AGUARDANDO_PAGAMENTO` (nenhuma compensação); e-mail "recusado"; dois
e-mails "pague para retirar", cada um com o seu link; depois `FINALIZADA`.

## 6. Cancelamento pelo atendente com compensações

OS nova em `AGUARDANDO_APROVACAO` (3.1 e 3.2). O corpo pode ser `{}` (o único motivo manual é
`OPERADOR`; `ORCAMENTO_REJEITADO`, `TIMEOUT_APROVACAO` etc. são da saga — outro valor dá `400`).

```bash
$ curl -s -XPOST $OS/ordens-servico/$OID/cancelar -H "Authorization: Bearer $ATD" -H "$J" -d '{}' -o /dev/null -w 'HTTP %{http_code}\n'
HTTP 200

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'CANCELADA', motivoCancelamento: 'OPERADOR', valorTotal: 300 }

$ curl -s $OS/ordens-servico/numero/$N/saga -H "Authorization: Bearer $ATD" | campo '(...)'
{
  passo: 'AGUARDAR_APROVACAO', status: 'CANCELADA',
  compensacoes: [ 'billing.cancelar-orcamento (confirmada)', 'execucao.liberar-reservas (confirmada)' ],
  ultimos: [
    'os.cancelamento-manual -> compensando [OPERADOR: billing.cancelar-orcamento, execucao.liberar-reservas]',
    'billing.orcamento-cancelado -> confirmacao [1 compensacao(oes) pendente(s)]',
    'execucao.reservas-liberadas -> cancelada [todas as compensacoes confirmadas]'
  ]
}

$ curl -s "$BILL/__stub/chamadas?numeroOS=$N" | campo 'o.map(c=>c.rota+" -> "+c.status+" "+JSON.stringify(c.body??null))'
[
  'POST /orcamentos -> 201 {"numeroOS":"OS-2026-4440736805-8920","clienteId":"efa45cc5-4d69-41cb-bd6d-d5238e878441","itens":[...]}',
  'DELETE /orcamentos/{n} -> 200 {"motivo":"OPERADOR"}'
]

$ curl -s "$EXEC/__stub/chamadas?numeroOS=$N" | campo 'o.map(c=>c.rota+" -> "+c.status+" "+JSON.stringify(c.body??null))'
[
  'POST /execucao/ordens -> 201 {"numeroOS":"OS-2026-4440736805-8920","veiculoId":"2fb192b1-b498-46f9-8896-3e60b758603d","descricaoProblema":"Barulho ao frear"}',
  'DELETE /execucao/ordens/{n} -> 200 {"motivo":"OS cancelada (compensacao da saga)"}'
]

$ curl -s $BILL/__stub/orcamentos/$N | campo 'o.status'; curl -s $EXEC/__stub/ordens/$N | campo 'o.status'
CANCELADO
LIBERADA

$ curl -s "$MAIL/api/v1/search?query=$N" | campo '...'
23:45:36 maria.souza@cliente.test | Status da OS OS-2026-4440736805-8920: EM_DIAGNOSTICO
23:45:37 maria.souza@cliente.test | Orcamento da OS OS-2026-4440736805-8920 pronto para aprovacao
23:45:37 maria.souza@cliente.test | OS OS-2026-4440736805-8920 cancelada
```

Conferir: as duas compensações (`DELETE /orcamentos/{n}` e `DELETE /execucao/ordens/{n}`)
chegaram com `{ motivo }` e foram confirmadas; Billing `CANCELADO`, Execução `LIBERADA`. Em
`EM_DIAGNOSTICO` só há `execucao.liberar-reservas` (ainda não há orçamento); em `EM_EXECUCAO` o
cancelamento é recusado com `400` (coberto no BDD).

## 7. Retry esgotado + reprocessamento

OS nova em `EM_DIAGNOSTICO` (3.1). O Billing vai responder 503 às próximas 3 chamadas de
`POST /orcamentos` — exatamente as 3 tentativas do cliente HTTP do OS:

```bash
$ curl -s -XPOST $BILL/__stub/cenario -H "$J" -d '{"falhar5xx":3,"rota":"POST /orcamentos"}' | campo '({falhar5xx:o.falhar5xx,rota:o.rota})'
{ falhar5xx: 3, rota: 'POST /orcamentos' }

$ curl -s -XPOST $EXEC/execucao/ordens/$N/diagnostico ... | campo '({estado:o.estado.status,callback:o.callback})'
{
  estado: 'DIAGNOSTICADA',
  callback: { id: '01a1cd00-b5d3-7128-af99-b60bb795ef64', type: 'execucao.diagnostico-concluido', status: 200,
    body: { aplicado: true, passo: 'GERAR_ORCAMENTO', status: 'EM_ANDAMENTO' }, repeticoes409: 0 }
}

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'EM_DIAGNOSTICO', motivoCancelamento: null, valorTotal: 300 }

$ curl -s $OS/ordens-servico/numero/$N/saga -H "Authorization: Bearer $ATD" | campo '(...)'
{
  passo: 'GERAR_ORCAMENTO', status: 'EM_ANDAMENTO', compensacoes: [],
  ultimos: [
    'execucao.enfileirada -> avancou [ENFILEIRAR_EXECUCAO -> AGUARDAR_DIAGNOSTICO]',
    'execucao.diagnostico-concluido -> avancou [AGUARDAR_DIAGNOSTICO -> GERAR_ORCAMENTO]',
    'billing.gerar-orcamento -> chamada-falhou [HTTP 503 apos 3 tentativa(s): POST http://billing-service:3001/orcamentos respondeu 503 (tentativa 3/3)]'
  ]
}

$ curl -s "$BILL/__stub/chamadas?numeroOS=$N" | campo 'o.map(c=>c.em.slice(11,23)+" "+c.rota+" -> "+c.status+(c.injetado?" (injetado)":""))'
[
  '23:45:38.274 POST /orcamentos -> 503 (injetado)',
  '23:45:38.478 POST /orcamentos -> 503 (injetado)',
  '23:45:39.282 POST /orcamentos -> 503 (injetado)'
]

$ curl -s $OS/metrics | grep -E '^oficina_http_interno_total.*resultado="esgotado"' | grep -v ' 0$'
oficina_http_interno_total{origem="os-service",destino="billing-service",rota="POST /orcamentos",resultado="esgotado",service="os-service"} 1

$ docker compose -f docker-compose.fase4.yml logs --no-log-prefix os-service | grep -h "\"correlation_id\":\"$N\"" | grep -E 'tentativa|esgot' | node -e '...'
comando nao entregue — tentativas esgotadas | POST /orcamentos | tentativa=3 | esgotado
comando nao entregue ao participante — saga fica no passo (alerta de saga parada / reprocessar) |  | tentativa=3 | esgotado
```

Conferir: o callback foi aplicado (a OS recebeu o diagnóstico), mas a saga **parou** em
`GERAR_ORCAMENTO` com `chamada-falhou` (3 tentativas); os intervalos entre as tentativas
(~200 ms e ~800 ms) são o backoff do kit; `resultado="esgotado"` +1; log de erro com
`tentativa=3`.

O gauge `oficina_os_sagas_paradas` é recalculado pelo relógio da saga (no compose a cada 10 s,
`SAGA_TIMEOUTS_INTERVALO_MS=10000`; padrão 60 s), então sobe alguns segundos depois. Medição feita
numa OS separada, com polling:

```bash
$ (polling) oficina_os_sagas_paradas ate subir:
oficina_os_sagas_paradas=1 (4s depois do retry esgotado)
```

Reprocessar (runbook [`saga-reprocessar.md`](../runbooks/saga-reprocessar.md)) reenvia o comando
pendente — idempotente por `numeroOS` — e a saga segue:

```bash
$ curl -s -XPOST $OS/admin/sagas/$N/reprocessar -H "Authorization: Bearer $ADM" | campo '({reenviados:o.reenviados,passo:o.saga.passo,status:o.saga.status})'
{ reenviados: [ 'billing.gerar-orcamento' ], passo: 'AGUARDAR_APROVACAO', status: 'EM_ANDAMENTO' }

$ curl -s $OS/ordens-servico/numero/$N/status | campo '(...)'
{ status: 'AGUARDANDO_APROVACAO', motivoCancelamento: null, valorTotal: 300 }

$ for i in $(seq 1 30); do V=$(curl -s $OS/metrics | grep -E '^oficina_os_sagas_paradas' | awk '{print $2}'); [ "$V" = 0 ] && break; sleep 1; done; echo "oficina_os_sagas_paradas=$V (apos ${i}s de polling)"
oficina_os_sagas_paradas=0 (apos 1s de polling)
```

(Na OS da medição separada o gauge voltou a 0 em 10 s, um ciclo do relógio.)

Variações cobertas no BDD: `falhar5xx: 2` (o retry absorve, sem reprocessar) e a Execução fora do
ar na abertura (OS fica `RECEBIDA` até reprocessar).

## 8. Idempotência de callback

OS nova; o mecânico diagnostica e a Execução **reenvia o mesmo envelope** (mesmo `id`):

```bash
$ curl -s -XPOST $EXEC/__stub/callbacks/$N/reenviar | campo 'o.callback'
{
  id: '01a1cd00-bec5-767e-9d88-0374de44a9d9', type: 'execucao.diagnostico-concluido', status: 200,
  body: { aplicado: false, duplicado: true, passo: 'AGUARDAR_APROVACAO', status: 'EM_ANDAMENTO' },
  repeticoes409: 0
}

$ curl -s "$BILL/__stub/chamadas?numeroOS=$N&rota=POST%20/orcamentos" | campo 'o.length+" chamada(s) em POST /orcamentos"'
1 chamada(s) em POST /orcamentos
```

Conferir: `duplicado: true` com o mesmo `id` do diagnóstico; um único orçamento; um único e-mail
"pronto para aprovacao"; `oficina_callbacks_total{resultado="duplicado"}` +1.

## 9. Divergências de contrato

Nenhuma no roteiro inteiro:

```bash
$ curl -s $BILL/__stub/violacoes; echo; curl -s $EXEC/__stub/violacoes
[]
[]
```

Os stubs validam o corpo de cada comando recebido do OS, as próprias respostas e cada envelope de
callback contra `docs/contratos/schemas/`; o BDD reprova o cenário se aparecer alguma violação.

## 10. BDD ponta a ponta

```bash
$ npm run test:bdd:e2e
...
1 hook (1 passed)
12 scenarios (12 passed)
168 steps (168 passed)
0m 6.901s (0m 6.825s executing your code)
```

Relatório HTML: `reports/cucumber/e2e.html`.

## 11. Trocar os stubs pelas imagens reais

```bash
BILLING_IMAGE=<registry>/soat-fiap-oficina-billing-service:<tag> \
EXECUCAO_IMAGE=<registry>/soat-fiap-oficina-execucao-service:<tag> \
  docker compose -f docker-compose.fase4.yml --profile reais up -d --build --wait
BDD_E2E_REAIS=1 npm run test:bdd:e2e     # pula os cenarios @stub (que usam /__stub/*)
```

O profile `reais` sobe o Postgres `oficina_billing` e o DynamoDB Local. Mercado Pago: aponte
`MERCADO_PAGO_BASE_URL` do Billing para um mock e dispare o webhook `order.processed` em
`POST /webhooks/mercadopago` no lugar de `POST /__stub/pagamentos/{n}`.

## 12. Derrubar

```bash
npm run e2e:down      # docker compose -f docker-compose.fase4.yml down -v --remove-orphans
```

## Limitações e observações

- **`traceparent`**: sem APM (`DD_TRACE_ENABLED=false` no compose) o kit 0.3.0 não envia
  `traceparent` nas chamadas internas — o `GET /__stub/chamadas` mostra `traceparent` vazio. A
  correlação local é pelo `x-correlation-id` (= número da OS), presente em todas as chamadas e
  callbacks. O trace distribuído continua no item 1 de [`evidencias-pendentes.md`](evidencias-pendentes.md).
- **`correlationId` × `correlation_id` no log da abertura**: nas linhas do OS geradas dentro do
  `POST /ordens-servico`, `correlation_id` é o número da OS, mas o campo `correlationId` do kit é o
  UUID da requisição (o número ainda não existia quando o middleware rodou). Filtre por
  `correlation_id`.
- **Gauge de sagas paradas**: muda no próximo ciclo do relógio da saga, não no instante do retry
  esgotado (ver seção 7).
