# Arquitetura — Fase 4

Desenho da arquitetura final da Fase 4: o monólito virou **três microsserviços**
(OS, Billing e Execução) que conversam por **HTTP direto com callbacks**
(RFC-0008), cada um com o **próprio banco** (duas instâncias RDS Postgres + DynamoDB), todos
atrás do **mesmo API Gateway** e orquestrados por uma **saga** que vive no OS
Service. Os diagramas estão em [Mermaid](https://mermaid.js.org/) e são
renderizados diretamente pelo GitHub. A Fase 4 é uma **evolução** da
[Arquitetura da Fase 3](arquitetura-fase3.md): a rede, o gateway e a
autenticação por CPF continuam; muda o que roda dentro do cluster e como os
pedaços se falam.

> Para o PDF e os slides, as imagens já exportadas estão em
> [`diagramas/fase4/`](diagramas/fase4/) (`01-visao-geral.png` … `08-deploy-eks.png`).
> Para regenerar após editar um bloco:
> `npx -p @mermaid-js/mermaid-cli mmdc -i docs/arquitetura/arquitetura-fase4.md -o /tmp/fase4.png -b white -s 2`
> (ou cole o bloco em <https://mermaid.live>).

Fontes de verdade: Terraform em `soat-fiap-oficina-infra-k8s` (`cluster/`,
`gateway/`, `observability/`) e `soat-fiap-oficina-infra-db`; contrato
[`docs/contratos/http-interno.md`](../contratos/http-interno.md); saga em
`src/ordem-de-servico/saga/domain/saga-os.entity.ts`.

---

## 1. Visão geral: microsserviços, bancos e comunicação

O **API Gateway é o único ponto público**. As UIs e o cliente autenticam na
Lambda de CPF e chamam os três serviços pelo mesmo host, roteados **por
prefixo** (`/ordens-servico`, `/orcamentos`, `/execucao`, ...). Entre si os
serviços **não passam pelo gateway**: o OS Service chama Execução e Billing pelo
DNS interno do cluster com um **JWT de serviço** (`role: SERVICO`) e recebe as
respostas assíncronas por **callbacks** em `POST /ordens-servico/{n}/eventos`.
O Mercado Pago entra pelo gateway num único webhook público do Billing.

```mermaid
flowchart TB
    subgraph UI["Clientes / UIs"]
        ADMIN["web/admin<br/>(atendente, mecânico, gestor)"]
        CLI["web/cliente<br/>(cliente: só CPF)"]
    end

    MP["Mercado Pago<br/>Checkout Pro (API de Orders)"]

    subgraph AWS["AWS"]
        GW["API Gateway (HTTP API)<br/>rotas por prefixo · Lambda Authorizer · throttling"]
        LAMBDA["Lambda de autenticação por CPF<br/>POST /auth · emite e valida JWT"]

        subgraph VPC["VPC 10.0.0.0/16 — subnets privadas"]
            NLB["NLB interno<br/>3 listeners → NodePort 30080 / 30081 / 30082"]

            subgraph EKS["Cluster EKS — namespace oficina"]
                OS["<b>OS Service</b> :3000<br/>clientes, veículos, OS,<br/>orquestrador da saga,<br/>notificação in-process"]
                BILL["<b>Billing Service</b> :3001<br/>orçamento, aprovação,<br/>cobrança e webhook MP"]
                EXEC["<b>Execução Service</b> :3002<br/>fila, diagnóstico,<br/>catálogo e estoque"]
            end

            RDSOS[("RDS PostgreSQL do OS<br/>oficina_mecanica")]
            RDSBI[("RDS PostgreSQL do Billing<br/>oficina_billing")]
            VPCE["VPC Gateway Endpoint<br/>DynamoDB (política por tabela)"]
        end

        DYNAMO[("DynamoDB<br/>tabela única da Execução<br/>PK/SK + GSI1 + GSI2")]
    end

    ADMIN & CLI -- "Bearer JWT" --> GW
    GW -- "POST /auth" --> LAMBDA
    GW -. "authorizer" .-> LAMBDA
    GW -- "VPC Link" --> NLB
    NLB -- "/ordens-servico, /clientes, /veiculos, /admin…" --> OS
    NLB -- "/orcamentos, /pagamentos, /webhooks" --> BILL
    NLB -- "/execucao, /catalogo, /estoque" --> EXEC

    OS == "POST /execucao/ordens · /iniciar · DELETE<br/>(JWT SERVICO, retry 5xx)" ==> EXEC
    OS == "POST /orcamentos · /cobrar · DELETE" ==> BILL
    EXEC -. "callback: diagnostico-concluido, finalizada" .-> OS
    BILL -. "callback: orcamento-aprovado/rejeitado,<br/>pagamento-aprovado/recusado" .-> OS

    OS --> RDSOS
    BILL --> RDSBI
    LAMBDA -- "consulta CPF/status" --> RDSOS
    EXEC --> VPCE --> DYNAMO
    BILL -- "POST /v1/orders" --> MP
    MP -- "webhook order (x-signature)" --> GW
```

**Legenda:** linha cheia = chamada síncrona do usuário; linha grossa = comando da
saga (OS → serviço, resposta imediata vira evento); pontilhada = callback.
Fora do desenho, para não poluir: **Secrets Manager** entrega o segredo do JWT,
a `DATABASE_URL` de cada serviço e as credenciais do Mercado Pago; o **agente
Datadog** no cluster recolhe traces, logs e métricas dos três serviços.

| Serviço | Repositório | Banco | O que guarda |
|---|---|---|---|
| OS Service | `soat-fiap-oficina-os-service` (este, hub de docs) | RDS próprio, Postgres `oficina_mecanica` | clientes, veículos, OS com snapshot dos itens, `saga_os`, `processed_messages`, notificações, usuários |
| Billing Service | `soat-fiap-oficina-billing-service` | RDS próprio, Postgres `oficina_billing` | orçamentos e itens, aprovação/rejeição, cobranças (order do Mercado Pago), eventos de webhook |
| Execução Service | `soat-fiap-oficina-execucao-service` | DynamoDB (tabela única, via VPC Endpoint) | fila de execução, diagnóstico, catálogo de serviços/produtos, reservas e movimentos de estoque |

---

## 2. Rede: a VPC e o caminho de uma requisição

Uma VPC `10.0.0.0/16` em **duas zonas de disponibilidade**, com uma subnet
pública e uma privada por AZ. Tudo o que executa fica nas **subnets privadas**:
nodes do EKS, NLB interno, as duas instâncias RDS e as ENIs da Lambda. O
DynamoDB é um serviço regional e não tem interface na VPC; ele é alcançado por
um **VPC Gateway Endpoint** (gratuito) nas route tables privadas, com política
restrita à tabela da Execução, sem passar pelo NAT. As subnets públicas só têm
o **Internet Gateway** e um **NAT Gateway** (um só, na primeira AZ, por custo),
por onde os nodes saem para ECR, Secrets Manager, Datadog e Mercado Pago. Não há nenhum load balancer público: a entrada é sempre o API Gateway,
que alcança o NLB pelo **VPC Link**.

```mermaid
flowchart TB
    USERS["UIs · cliente · Mercado Pago"]
    GW["API Gateway (HTTP API)<br/>fora da VPC · único ponto público"]
    LAMBDA["Lambda de CPF<br/>ENIs nas subnets privadas · SG auth_lambda"]

    subgraph VPC["VPC 10.0.0.0/16 · us-east-1 · 2 AZs"]
        direction TB
        VPCLINK["VPC Link (SG vpc_link)"]
        NLB["NLB interno (internal = true)<br/>uma ENI por AZ · 3 listeners → NodePort 30080 / 30081 / 30082"]

        subgraph PUB["Subnets públicas 10.0.0.0/20 (AZ a) · 10.0.16.0/20 (AZ b)"]
            IGW["Internet Gateway"]
            NAT["NAT Gateway + EIP<br/>(só na AZ a, por custo)"]
        end

        subgraph PRIV["Subnets privadas 10.0.128.0/20 (AZ a) · 10.0.144.0/20 (AZ b)"]
            NODES["Managed node group EKS<br/>t3.medium · 2 a 4 nodes · espalhados nas 2 AZs<br/>pods: os-service · billing-service · execucao-service · datadog"]
            RDSOS[("RDS do OS Service<br/>Multi-AZ · oficina_mecanica")]
            RDSBI[("RDS do Billing<br/>Multi-AZ · oficina_billing")]
        end

        VPCE["VPC Gateway Endpoint · DynamoDB<br/>nas route tables privadas · política só para a tabela oficina-execucao"]

        CP["EKS control plane (gerenciado pela AWS)<br/>endpoint público + privado"]
    end

    DYN[("DynamoDB<br/>tabela oficina-execucao")]
    subgraph REG["Serviços regionais (endpoints públicos, via NAT)"]
        ECR["ECR"]
        SM["Secrets Manager · SSM"]
        CW["CloudWatch"]
    end
    EXT["Datadog (SaaS) · Mercado Pago"]

    USERS -- "HTTPS" --> GW
    GW -- "POST /auth · authorizer" --> LAMBDA
    GW -- "VPC Link" --> VPCLINK --> NLB
    NLB -- "TCP → NodePort" --> NODES
    NODES -- "5432 (SG dos nodes)" --> RDSOS & RDSBI
    LAMBDA -- "5432 (SG auth_lambda)" --> RDSOS
    NODES -- "rota do prefixo do DynamoDB" --> VPCE --> DYN
    CP -. "kubelet / API" .- NODES
    NODES -- "0.0.0.0/0" --> NAT --> IGW
    IGW --> REG
    IGW --> EXT
```

Regras de segurança que importam:

- **RDS**: uma instância por serviço (ADR-0014), cada uma com o próprio security group aceitando 5432 só dos nodes (e da Lambda, no caso do OS), nunca da internet (`publicly_accessible = false`). O segredo de cada serviço só contém o próprio host.
- **DynamoDB** só é alcançado pelo VPC Gateway Endpoint, cuja política permite apenas a tabela `oficina-execucao` e seus índices; o tráfego nunca sai para a internet.
- **NLB** é `internal = true`; o target group aponta para os **nodes** (NodePort), por isso não precisa de AWS Load Balancer Controller.
- **VPC Link** tem SG próprio com saída apenas para o NLB/nodes.
- A **Lambda** fica na VPC para chegar ao RDS; sai para o Secrets Manager pelo NAT.
- As chamadas **entre serviços** nunca saem do cluster: `http://billing-service:3001`, `http://execucao-service:3002` (DNS do namespace `oficina`).

Custo: o desenho é o mínimo para alta disponibilidade do banco e do cluster
(duas AZs, RDS Multi-AZ) com um único NAT Gateway e um endpoint de gateway gratuito; o cluster fica **desligado**
fora das janelas de demo e é recriado pelo CI do `infra-k8s`.

---

## 3. O fluxo de uma OS entre os microsserviços

Numa página: a OS nasce no OS Service, vai para a fila da Execução, volta como
diagnóstico, vira orçamento no Billing, o cliente aprova, a Execução executa,
o Billing cobra no Mercado Pago, o pagamento confirma e o atendente entrega.
O OS Service é o único que **manda** (linhas grossas); os outros dois
**respondem** na hora ou **avisam depois** por callback (pontilhadas). Os
números são a ordem dos passos; o detalhe de cada um está na sequência 3.2.

```mermaid
flowchart LR
    AT((Atendente))
    ME((Mecânico))
    CL((Cliente))
    MP["Mercado Pago<br/>Checkout Pro"]

    OS["<b>OS Service</b> · orquestrador da saga · Postgres<br/><br/>RECEBIDA → EM_DIAGNOSTICO → AGUARDANDO_APROVACAO<br/>→ EM_EXECUCAO → AGUARDANDO_PAGAMENTO<br/>→ FINALIZADA → ENTREGUE"]
    EX["<b>Execução Service</b> · DynamoDB<br/><br/>fila · diagnóstico · reserva e baixa<br/>de estoque · catálogo · finalização"]
    BI["<b>Billing Service</b> · Postgres<br/><br/>orçamento · aprovação/rejeição<br/>· cobrança · webhook de pagamento"]

    AT -- "⓪ abre a OS · ⑩ entrega" --> OS
    OS == "① POST /execucao/ordens<br/>⑤ POST …/{n}/iniciar" ==> EX
    EX -. "③ diagnostico-concluido<br/>⑦ finalizada" .-> OS
    OS == "③ POST /orcamentos<br/>⑦ POST …/{n}/cobrar" ==> BI
    BI -. "⑤ orcamento-aprovado<br/>⑨ pagamento-aprovado" .-> OS
    ME -- "② diagnostica · ⑥ finaliza" --> EX
    CL -- "④ aprova o orçamento" --> BI
    BI -- "⑦ POST /v1/orders" --> MP
    CL -- "⑧ paga" --> MP
    MP -- "⑧ webhook order" --> BI
```

Se o cliente **rejeita** (ou o prazo de aprovação vence), o OS Service chama
`DELETE /execucao/ordens/{n}` e `DELETE /orcamentos/{n}` e a OS vai para
`CANCELADA`. Se o **pagamento é recusado**, nada é desfeito: a OS fica retida em
`AGUARDANDO_PAGAMENTO` até o atendente resolver.

### 3.1 Máquina de estados e quem é o dono de cada transição

Cobrança **depois** da execução (decisão de 03/11): o cliente aprova o
orçamento, o serviço é feito, e só então nasce a cobrança no Mercado Pago.

```mermaid
stateDiagram-v2
    [*] --> RECEBIDA : POST /ordens-servico (Atendente, OS)
    RECEBIDA --> EM_DIAGNOSTICO : 201 de POST /execucao/ordens (Execução)
    EM_DIAGNOSTICO --> AGUARDANDO_APROVACAO : callback execucao.diagnostico-concluido + 201 de POST /orcamentos (Execução → Billing)
    AGUARDANDO_APROVACAO --> EM_EXECUCAO : callback billing.orcamento-aprovado + 200 de /iniciar (Billing → Execução)
    AGUARDANDO_APROVACAO --> CANCELADA : callback billing.orcamento-rejeitado ou timeout (compensa: DELETE na Execução)
    EM_EXECUCAO --> AGUARDANDO_PAGAMENTO : callback execucao.finalizada + 201 de /cobrar (Execução → Billing)
    AGUARDANDO_PAGAMENTO --> FINALIZADA : callback billing.pagamento-aprovado (Billing)
    AGUARDANDO_PAGAMENTO --> AGUARDANDO_PAGAMENTO : pagamento-recusado ou timeout: fica retida, sem compensar
    FINALIZADA --> ENTREGUE : POST /ordens-servico/{id}/entregar (Atendente, OS)
    RECEBIDA --> CANCELADA : cancelamento manual (compensa Execução e Billing)
    EM_DIAGNOSTICO --> CANCELADA : cancelamento manual ou 409 da Execução
    ENTREGUE --> [*]
    CANCELADA --> [*]
```

A saga no OS Service (`saga_os`) acompanha a OS passo a passo:
`ENFILEIRAR_EXECUCAO → AGUARDAR_DIAGNOSTICO → GERAR_ORCAMENTO → AGUARDAR_APROVACAO
→ INICIAR_EXECUCAO → AGUARDAR_FINALIZACAO → COBRAR → AGUARDAR_PAGAMENTO → CONCLUIDA`.
Cada evento recebido (resposta síncrona ou callback) é aplicado numa **única
transação** com a OS; comandos para os outros serviços saem **depois do commit**
e a resposta é reinjetada como novo evento. Duplicatas são ignoradas pelo `id`
do envelope (`processed_messages`).

### 3.2 Caminho feliz

```mermaid
sequenceDiagram
    autonumber
    actor AT as Atendente
    actor ME as Mecânico
    actor CL as Cliente
    participant GW as API Gateway
    participant OS as OS Service<br/>(saga)
    participant EX as Execução Service
    participant BI as Billing Service
    participant MP as Mercado Pago

    AT->>GW: POST /ordens-servico
    GW->>OS: cria OS RECEBIDA · saga ENFILEIRAR_EXECUCAO
    OS->>EX: POST /execucao/ordens (JWT SERVICO)
    EX-->>OS: 201 { posicaoFila } ≙ execucao.enfileirada
    OS->>OS: EM_DIAGNOSTICO · AGUARDAR_DIAGNOSTICO

    ME->>GW: POST /execucao/ordens/{n}/diagnostico (itens, reserva estoque)
    GW->>EX: grava diagnóstico + reservas (DynamoDB)
    EX-->>OS: callback execucao.diagnostico-concluido
    OS->>OS: snapshot dos itens · GERAR_ORCAMENTO
    OS->>BI: POST /orcamentos { itens }
    BI-->>OS: 201 { total, validoAte } ≙ billing.orcamento-gerado
    OS->>OS: AGUARDANDO_APROVACAO · notifica cliente (e-mail)

    CL->>GW: POST /orcamentos/{n}/aprovar (JWT CLIENTE)
    GW->>BI: marca aprovado
    BI-->>OS: callback billing.orcamento-aprovado
    OS->>EX: POST /execucao/ordens/{n}/iniciar
    EX-->>OS: 200 ≙ execucao.iniciada (baixa efetiva do estoque)
    OS->>OS: EM_EXECUCAO · AGUARDAR_FINALIZACAO

    ME->>GW: POST /execucao/ordens/{n}/finalizar
    GW->>EX: encerra execução
    EX-->>OS: callback execucao.finalizada
    OS->>OS: AGUARDANDO_PAGAMENTO · COBRAR
    OS->>BI: POST /orcamentos/{n}/cobrar
    BI->>MP: POST /v1/orders (checkout)
    MP-->>BI: order + checkout_url
    BI-->>OS: 201 { orderId, linkPagamento } ≙ billing.cobranca-criada
    OS->>OS: AGUARDAR_PAGAMENTO · e-mail com o link

    CL->>MP: paga no Checkout Pro
    MP->>GW: POST /webhooks/mercadopago (x-signature)
    GW->>BI: valida assinatura, consulta a order
    BI-->>OS: callback billing.pagamento-aprovado
    OS->>OS: FINALIZADA · saga CONCLUIDA

    AT->>GW: POST /ordens-servico/{id}/entregar
    GW->>OS: ENTREGUE
```

### 3.3 Compensação: cliente rejeita o orçamento

Falha de negócio **antes** da execução → a saga entra em `COMPENSANDO`, chama
os `DELETE` dos dois serviços (idempotentes) e encerra a OS como `CANCELADA`.
O mesmo caminho atende o cancelamento manual pelo atendente e o timeout de
aprovação.

```mermaid
sequenceDiagram
    autonumber
    actor CL as Cliente
    participant GW as API Gateway
    participant OS as OS Service<br/>(saga)
    participant EX as Execução Service
    participant BI as Billing Service

    CL->>GW: POST /orcamentos/{n}/rejeitar
    GW->>BI: marca rejeitado
    BI-->>OS: callback billing.orcamento-rejeitado
    OS->>OS: saga COMPENSANDO (OS ainda AGUARDANDO_APROVACAO)
    par compensações
        OS->>EX: DELETE /execucao/ordens/{n} { motivo }
        EX-->>OS: 200 ≙ execucao.reservas-liberadas (tira da fila, devolve reservas)
    and
        OS->>BI: DELETE /orcamentos/{n} { motivo }
        BI-->>OS: 200 ≙ billing.orcamento-cancelado
    end
    OS->>OS: OS CANCELADA (motivo) · saga CANCELADA · notifica cliente
```

### 3.4 Pagamento recusado e timeouts

Depois da execução o serviço já foi prestado, então **não há rollback**: a OS
fica retida em `AGUARDANDO_PAGAMENTO` e o atendente resolve (nova cobrança ou
baixa manual). Os timeouts são eventos internos `saga.timeout` gerados pelo
`SagaTimeoutsService`.

```mermaid
sequenceDiagram
    autonumber
    participant MP as Mercado Pago
    participant BI as Billing Service
    participant OS as OS Service<br/>(saga)
    participant T as SagaTimeoutsService
    actor AT as Atendente

    MP->>BI: webhook order (recusada / cancelada)
    BI-->>OS: callback billing.pagamento-recusado
    OS->>OS: registra pendência · segue AGUARDANDO_PAGAMENTO · e-mail ao cliente
    T->>OS: saga.timeout (SAGA_TIMEOUT_PAGAMENTO_HORAS)
    OS->>OS: marca saga parada (gauge oficina_os_sagas_paradas) · alerta
    AT->>OS: POST /admin/sagas/{n}/reprocessar ou nova cobrança
    Note over OS,T: Timeout de APROVAÇÃO (SAGA_TIMEOUT_APROVACAO_DIAS) segue o fluxo 3.3: compensa e cancela.
```

### 3.5 Como as chamadas são protegidas

| Mecanismo | Onde | O que garante |
|---|---|---|
| JWT de serviço (`role: SERVICO`, 50 min em cache) | kit `@guilhermeqmaia/oficina-kit/http` | só serviços chamam endpoints internos e o callback |
| Retry 3x com backoff (200/800/3000 ms) só em 5xx, timeout e erro de rede; timeout 5 s | kit `/http` | `409` de negócio vira evento de falha, nunca é repetido |
| Idempotência por `numeroOS` (serviços) e por `id` do envelope (OS) | Billing, Execução, `processed_messages` no OS | reentrega não duplica orçamento, reserva ou transição |
| Lock otimista (`version`) + retry em `ConcurrentModificationError` | OS Service | callback e resposta síncrona concorrentes não perdem transição |
| `x-correlation-id` + `traceparent` propagados | kit `/http` + Datadog APM | uma OS é um trace só atravessando os três serviços |

---

## 4. Deploy no EKS

Três `Deployment`s no namespace `oficina`, cada um com `Service` **NodePort
fixo** (é o que o target group do NLB conhece), `HPA` por CPU/memória e um `Job`
de migração (Prisma) para os dois serviços Postgres. O CI de cada repositório
faz build, testes, quality gate, publica a imagem no ECR e aplica o overlay
`k8s-aws` no cluster.

```mermaid
flowchart LR
    subgraph CI["GitHub Actions (um por repositório, OIDC → AWS)"]
        CIOS["os-service"]
        CIBI["billing-service"]
        CIEX["execucao-service"]
    end
    ECR["ECR (tag por commit)"]

    subgraph EKS["EKS — namespace oficina"]
        subgraph OSD["OS Service"]
            DOS["Deployment (2–10 réplicas, HPA)"]
            SOS["Service NodePort 30080 → 3000"]
            JOS["Job prisma migrate"]
        end
        subgraph BID["Billing Service"]
            DBI["Deployment (HPA)"]
            SBI["Service NodePort 30081 → 3001"]
            JBI["Job prisma migrate"]
        end
        subgraph EXD["Execução Service"]
            DEX["Deployment (HPA)"]
            SEX["Service NodePort 30082 → 3002"]
        end
        DDA["Datadog Agent (DaemonSet)"]
        MS["metrics-server (add-on)"]
    end

    NLB["NLB interno<br/>listener 3000 → TG 30080<br/>listener 3001 → TG 30081<br/>listener 3002 → TG 30082"]
    RDSOS[("RDS do OS: oficina_mecanica")]
    RDSBI[("RDS do Billing: oficina_billing")]
    DYN[("DynamoDB (via VPC Endpoint)")]

    CIOS & CIBI & CIEX --> ECR
    CIOS --> DOS & JOS
    CIBI --> DBI & JBI
    CIEX --> DEX
    ECR -. pull .-> DOS & DBI & DEX
    NLB --> SOS --> DOS
    NLB --> SBI --> DBI
    NLB --> SEX --> DEX
    DOS & JOS --> RDSOS
    DBI & JBI --> RDSBI
    DEX --> DYN
    DOS -- "DNS interno" --> SBI & SEX
    MS -. métricas .-> DOS & DBI & DEX
```

---

## 5. Onde cada decisão está registrada

| Tema | Documento |
|---|---|
| Três serviços e o que ficou em cada um | [RFC-0004](rfcs/) |
| Saga orquestrada no OS Service | [RFC-0005](rfcs/), [US-F4-10](../user-stories/f4-10-saga-orquestrada.md), [US-F4-11](../user-stories/f4-11-compensacoes-rollback.md) |
| HTTP direto + callbacks no lugar de SNS/SQS | [RFC-0008](rfcs/RFC-0008-comunicacao-http-entre-servicos.md), [`http-interno.md`](../contratos/http-interno.md) |
| DynamoDB tabela única na Execução | [RFC-0007](rfcs/) |
| Kit compartilhado e cliente HTTP interno | [ADR-0010](adr/) |
| Mercado Pago via API de Orders, cobrança após a execução | [ADR-0012](adr/ADR-0012-pagamento-mercado-pago.md) |
| Gateway único com NLB e um listener por serviço | [ADR-0013](adr/) |
| Uma instância RDS por serviço e VPC Endpoint para o DynamoDB | [ADR-0014](adr/ADR-0014-instancia-rds-por-servico-e-endpoint-dynamodb.md), [US-F4-03](../user-stories/f4-03-bancos-por-servico.md) |
