# Plano de Execução — Fase 4 Tech Challenge

**Tema:** Microsserviços, Saga Pattern e automação completa · **Enunciado:** [`docs/tech-challenges/fase-4-tech-challenge.pdf`](tech-challenges/fase-4-tech-challenge.pdf)

> Este documento faz para a Fase 4 o que [`plano-execucao-fase-3.md`](plano-execucao-fase-3.md)
> fez para a Fase 3: resume o enunciado, registra o que o mercado faz, propõe as
> decisões (a serem formalizadas em RFC/ADR na Onda 0), mapeia os repositórios e
> organiza as histórias em ondas.

---

## O que a Fase 4 exige (resumo do enunciado)

| Requisito | Detalhe |
|---|---|
| **≥ 3 microsserviços** | cada um com repositório, infraestrutura e **banco próprios**; sugeridos: OS Service, Billing (orçamento + pagamento **Mercado Pago**), Execução |
| **Bancos** | pelo menos um **SQL** e pelo menos um **NoSQL**; **nenhum serviço acessa o banco de outro** (destacado no PDF) |
| **Comunicação** | REST síncrono quando necessário; mensageria assíncrona (RabbitMQ, Kafka, SQS…) citada como exemplo — o meio fica em aberto. *Decisão de 03/11: HTTP direto + callbacks (RFC-0008).* |
| **Saga Pattern** | coordenar abrir OS → orçamento → aprovação → execução, **com rollback/compensação em qualquer etapa**; orquestrada ou coreografada, **justificada no README** |
| **Testes e qualidade** | unitários em todos; **≥ 80 % por serviço**; **≥ 1 fluxo completo em BDD**; **SonarQube ou similar no CI** |
| **CI/CD por serviço** | build, testes, verificação de qualidade, deploy automatizado em Kubernetes; `main` protegida com checagens |
| **Infra** | deploy em Kubernetes; comunicação entre serviços (HTTP, RFC-0008); **observabilidade da Fase 3** |
| **Entrega** | repositórios (código, Dockerfile, manifestos, pipelines, **evidências de cobertura**, arquitetura do serviço, Swagger); **vídeo ≤ 15 min** (fluxo completo, saga com falha, deploy com testes, rastreamento distribuído); **PDF** (participantes, links, diagrama geral, estratégia de saga, justificativa da divisão e tecnologias) |

---

## O que o mercado brasileiro faz — insights de quem opera isso em escala

Pesquisa feita em artigos de engenheiros do **iFood**, **Mercado Livre**, **Nubank** e **Uber**
(fontes no fim da seção). Cada insight aponta para a decisão deste plano que ele sustenta.

### iFood — o pedido é uma máquina de estados, e o gateway do domínio é quem a guarda

Bruno Panuto (time *Connection*) descreve o ciclo de vida do pedido como estado
complexo — "pedidos confirmados podem ser cancelados, mas pedidos cancelados não
podem ser confirmados" — e conclui: **"estado complexo é mais fácil se manejado por
uma máquina de estados, onde os estados possíveis são definidos através de transições
válidas por eventos"**. O *Gateway Core* implementa essa máquina e, só depois de validar
o evento, o propaga via **SNS**; ingestão com workers em **SQS**; fallback do serviço de
polling em **DynamoDB** alimentado por lambdas a partir do mesmo SNS. Lições explícitas:
"monólitos nem sempre são ruins", "otimize escrita vs leitura" e a métrica que importa é o
**tempo de sair da ideia para o usuário real**.

No middleware financeiro (caso AWS), o iFood começou com **workshops de Event Storming**
para achar os bounded contexts, quebrou o monólito em **três** serviços com **um Postgres
por serviço**, ligados por **EventBridge em coreografia** com **DLQ, retry e replay**;
resultado: −90 % de MTTR, features de 1 mês para 1 semana.

Felipe Volpone (User Profile) mostra o outro lado: **1 bilhão de mensagens Kafka/dia**
gravadas em **DynamoDB** com `account_id` como partition key — os problemas reais foram
*commit em lote quando parte do batch falha*, *rebalanceamento* de consumidores e a
obrigação de **provar que nada foi perdido nem duplicado**.

→ Sustenta: **saga orquestrada com a máquina de estados da OS no OS Service** (D2),
**SNS+SQS** (D3), **DynamoDB** (D4), **DLQ + replay** (D6), **DDD como ponto de partida** (D1).

### Mercado Livre — liberdade demais custa caro; padronize o que não é domínio

Juliano Marcos Martins conta a saída do monólito (~2010) e o efeito colateral: **"we
transitioned from a state of utter chaos… to a state of chaotic freedom, where everyone
had unlimited control"** — times gastavam mais tempo em incidentes do que em produto.
A resposta foi a **Fury** (2015), plataforma interna que padroniza stack, **gera o repositório
com CI/CD e scaffolding**, faz deploy com estratégias por criticidade e observabilidade
embutida; hoje **30 mil microsserviços, 100 mil instâncias, 30 mil deploys/dia**. A lição
dele: "não se deixe seduzir pela tecnologia" e "a construção da plataforma não competiu
com a construção do produto".

→ Sustenta: **kit compartilhado + template de serviço** (D5), **CI/CD idêntico nos três
repositórios** e **quality gate uniforme** (D7).

### Nubank — imutabilidade, idempotência e nunca perder uma mensagem

Edward Wible e Rafael Ferreira (QCon 2017): microsserviços **desde o dia 1**, Clojure,
Datomic ("Git for your data") e **Kafka como log imutável** para desacoplamento lógico e
temporal. Regras operacionais que viraram cultura: **"any message that goes on Kafka
has to be idempotent"**; falha de consumo vai para um tópico de *dead letter* onde o serviço
**"mortician"** guarda a mensagem para triagem humana e republicação — "**if you are a
financial institution, data loss is the worst thing that can happen**"; circuit breaker pausa
o consumidor e a falha vira apenas *lag*. **Partidas dobradas** como sistema operacional
(não analítico) com testes de propriedade sobre as invariantes.

Lucas Cavalcanti (podcast InfoQ 2021) acrescenta dois arrependimentos úteis: código
"auto-corretivo" sem trilha de auditoria (**correções não podem viver "só na memória da
máquina"**) e a **falta de registro das decisões de arquitetura** — "doesn't scale for me to
explain everything to everyone every time".

→ Sustenta: **outbox + consumidor idempotente** (D6), **ledger append-only no Billing**
(D8), **DLQ com runbook de reprocessamento** (D6), **RFCs/ADRs antes do código** (Onda 0).

### Uber — domínios com gateway, e a saga é uma ferramenta, não um dogma

Adam Gluck (DOMA, 2020): 2.200 microsserviços viraram "monólitos em rede"; a meia-vida
de um serviço é **1,5 ano**, então cada **domínio expõe um gateway** (RPCs, eventos,
queries) e esconde tabelas e serviços internos — duas grandes reescritas aconteceram
atrás de gateways sem migrar consumidores. Ele lembra que microsserviços são "libraries
with a performance hit" adotadas por benefício **operacional**.

Na **plataforma de pagamentos** (Singla & Wu; Sheth et al., 2026): *money orders*
**imutáveis** que somam zero, ledger **fortemente consistente** (primeiro em **DynamoDB**),
serviços stateless sobre **Kafka**, **idempotência por IDs determinísticos** ("we process
orders after we persist them"), **versionamento** para manter dois sistemas assíncronos
consistentes, e **retries exponenciais por longos períodos** como base de um pagamento
confiável. O achado mais importante para nós vem do **Fulfillment** (Neerabail et al.,
2021): a arquitetura anterior usava **saga propose/commit/cancel** e o time a
**abandonou** — "between operations the system was internally inconsistent" e "debugging
across multiple entities became even harder" — trocando por transações ACID no Spanner e
por um *outbox* transacional (tabela **LATE**) para efeitos pós-commit.

→ Sustenta: **gateway único por domínio** (já temos: API Gateway da Fase 3, D9); **saga
orquestrada com estado explícito e consultável** para não cair na armadilha da Uber (D2);
**pagamento = ledger imutável + idempotência por id da order** (D8); e um aviso honesto
para o README: **saga é o custo de ter bancos separados**, não um fim em si.

### Síntese — o que o mercado espera de quem "faz microsserviços"

1. **Começa pelo domínio** (Event Storming → bounded contexts), não pela tecnologia.
2. **Máquina de estados explícita** para o agregado central (pedido/OS) num único dono.
3. **Mensagens idempotentes, outbox transacional, DLQ com reprocessamento humano** — o trio
   aparece em todas as quatro empresas com nomes diferentes.
4. **Padronização do que não é domínio** (plataforma/kit) para que serviços "nasçam iguais".
5. **Gateway estável por domínio**; serviços internos mudam, o contrato não.
6. **Dinheiro é imutável e soma zero**; nunca corrigir na mão.
7. **Registrar decisões** — o custo de não registrar é pago em explicações repetidas.

> Nota (03/11/2026): o item 3 foi revisado para o nosso tamanho — mantemos **idempotência** e
> **retry com reprocessamento humano**, mas sem broker, outbox ou DLQ: três serviços no mesmo
> cluster se falam por HTTP ([RFC-0008](arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md)).

**Fontes:** Bruno Panuto, [Conectando 60k restaurantes: a saga arquitetural do iFood](https://medium.com/movile-tech/conectando-60k-restaurantes-a-saga-arquitetural-do-ifood-7d1a42edd835) (2019) ·
Ricardo Marques & Abbas Zahid, [Como iFood se beneficiou da arquitetura orientada a eventos](https://aws.amazon.com/pt/blogs/aws-brasil/como-ifood-se-beneficiou-da-arquitetura-orientada-a-eventos-para-modernizar-seu-midware-financeiro/) (AWS, 2023) ·
Felipe Volpone, [Consuming over 1 billion Kafka messages per day at iFood](https://felipevolpone.medium.com/consuming-over-1-billion-kafka-messages-per-day-at-ifood-2465e1ffa795) (2021) ·
Confluent, [iFood case study](https://www.confluent.io/customers/ifood/) ·
Juliano Marcos Martins, [The technological evolution at Mercado Libre](https://medium.com/mercadolibre-tech/the-technological-evolution-at-mercado-libre-fb269776a4e8) e [Mercado Libre's Internal Developer Platform](https://platformengineering.org/blog/unveiling-the-secrets-of-a-successful-journey-mercado-libres-internal-developer-platform) (2024) ·
Edward Wible & Rafael Ferreira, [Architecting a Modern Financial Institution](https://www.infoq.com/presentations/nubank-architecture/) (QCon 2017) ·
Lucas Cavalcanti, [podcast InfoQ](https://www.infoq.com/podcasts/lucas-cavalcanti-nubank-fintech-clojure/) (2021) ·
Elton Peixoto & Diogo Dantas, [Managing Cloud Limits](https://building.nu.com/managing-cloud-limits/) (Nubank, 2025) ·
Adam Gluck, [Introducing DOMA](https://www.uber.com/us/en/blog/microservice-architecture/) (Uber, 2020) ·
Aakriti Singla & Simon Wu, [Money Movements at Scale with Strong Data Consistency](https://www.uber.com/us/en/blog/money-scale-strong-data/) (2020) ·
Nimish Sheth et al., [Zero-Sum by Design: 10 Years of Uber's Payments Platform](https://www.uber.com/us/en/blog/ubers-payments-platform/) (2026) ·
Neerabail et al., [Uber's Fulfillment Platform re-architecture](https://www.uber.com/us/en/blog/fulfillment-platform-rearchitecture/) (2021) ·
AWS, [Padrão Saga — Prescriptive Guidance](https://docs.aws.amazon.com/pt_br/prescriptive-guidance/latest/cloud-design-patterns/saga.html).

---

## Decisões (aprovadas pelo time em 30/09/2026; formalizadas em RFC-0004..0007 e ADR-0009..0013)

> **Revisão de 03/11/2026:** o time trocou a **mensageria SNS/SQS por comunicação HTTP
> direta entre os serviços** (chamadas síncronas com retry + callbacks HTTP para o OS
> Service) — [RFC-0008](arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md),
> contrato em [`docs/contratos/http-interno.md`](contratos/http-interno.md). D3, D6, D9 e
> D12 foram revisadas abaixo; RFC-0006 e ADR-0009 ficam como histórico. Na mesma data:
> pagamento **após a execução** (D8, PR #97), todos os serviços via API Gateway (D9),
> BDD com Gherkin + Cucumber como exigência do professor (US-F4-14) e cada história com
> seções "APIs que expõe / APIs que consome / O que salva no banco".

| # | Decisão | Proposta | Por quê (e insight que sustenta) |
|---|---|---|---|
| D1 | **Divisão dos microsserviços** | **3 serviços**: **OS Service** (Atendimento: Cliente, Veículo, OrdemDeServico, histórico, Notificação, **orquestrador da saga**), **Billing Service** (Orçamento, Pagamento/Mercado Pago, ledger), **Execução Service** (fila de execução, diagnóstico, **Catálogo + Estoque**) | Segue os exemplos do enunciado e nossos bounded contexts do Event Storming. Catálogo/Estoque vão com Execução porque é o mecânico quem adiciona peças e reserva estoque no diagnóstico — separar em 5 repos dobraria o custo de infra sem ganho didático (RFC-0004). *iFood: Event Storming primeiro.* |
| D2 | **Saga** | **Orquestrada**, orquestrador no OS Service, estado persistido em `saga_os` e consultável por API | O fluxo tem 6+ passos e compensações cruzadas; orquestração torna o estado **explícito, observável e testável** (o vídeo exige "rastreamento"). Coreografia com 3 participantes seria viável, mas as compensações ficariam implícitas — exatamente a dor relatada pela Uber. Notificação fica **coreografada** (só assina fatos) para mostrar os dois estilos (RFC-0005). |
| D3 | **Comunicação entre serviços** | **HTTP direto + callbacks** (revisada em 03/11): o orquestrador chama Execução/Billing por HTTP síncrono (timeout 5 s, 3 tentativas com backoff) e os participantes avisam o OS por `POST /ordens-servico/{numero}/eventos`; JWT de serviço (`role: SERVICO`); contrato em `docs/contratos/http-interno.md`. **SNS/SQS descartado em 03/11** (era a escolha original, RFC-0006) | Execução e Billing nascem como APIs REST comuns, sem publisher/consumer/outbox/DLQ/LocalStack; depuração com `curl` e traces HTTP; o enunciado deixa o meio de comunicação aberto — o que é avaliado é a saga com compensação. Três serviços no mesmo cluster tornam o acoplamento temporal aceitável. (RFC-0008) |
| D4 | **NoSQL** | **DynamoDB** no Execução Service (single-table: execução da OS com timeline, catálogo, estoque com *conditional writes*) | Serverless, free tier, Streams para o outbox; a "execução" é naturalmente um documento com linha do tempo. *iFood e Uber usam DynamoDB para exatamente isso.* (RFC-0007) |
| D5 | **Código comum** | Pacote **`@guilhermeqmaia/oficina-kit`** (npm) + **template de serviço**: auth resource server (+ `Role.SERVICO`), logs, métricas, **cliente HTTP interno** com retry/JWT de serviço/correlação (`/http`, US-F4-18); `messaging`/outbox ficam no pacote como descontinuados | Três serviços iguais no que não é domínio. *Mercado Livre (Fury) e Nubank ("every service is similar").* (ADR-0010) |
| D6 | **Confiabilidade** | **Retry/backoff** no cliente HTTP do kit + **idempotência** (comandos por `numeroOS`, callbacks por `id` do envelope em `processed_messages`) + **`reprocessar`** (`POST /admin/sagas/:numero/reprocessar`) quando o retry esgota — **sem outbox** (revisada em 03/11) | Falha de plataforma → retry (recuperação para frente); retry esgotado → saga parada → alerta `oficina_os_sagas_paradas` → reprocessar. Nunca editar estado à mão. A idempotência continua sendo a regra de ouro de Nubank/Uber. (RFC-0008; ADR-0009 histórica) |
| D7 | **Qualidade no CI** | **SonarCloud** (grátis para repos públicos) com quality gate bloqueante | "SonarQube ou similar" sem hospedar nada; badge = evidência de cobertura exigida. (ADR-0011) |
| D8 | **Pagamento** | **Mercado Pago Checkout Pro (API de Orders)** + webhook assinado; **pagamento acontece após a execução do serviço** (novo status `AGUARDANDO_PAGAMENTO` entre `EM_EXECUCAO` e `FINALIZADA`; comando `billing.cobrar` ao receber `execucao.finalizada`; decisão do time em 03/11); ledger append-only | Cobra-se só pelo serviço efetivamente realizado; nenhuma compensação precisa de estorno. Cartões de teste do sandbox produzem aprovado/recusado de forma determinística — a demo de pagamento pendente fica reproduzível. *Uber: ordens imutáveis, idempotência por ID, retries longos.* (ADR-0012) |
| D9 | **Borda** | **Mesmo API Gateway** da Fase 3, rotas por prefixo → 3 backends — **inclusive a Execução** (`/execucao*`, `/catalogo*`, `/estoque*`; confirmado em 03/11); **um NLB** com 3 listeners; Lambda de auth **inalterada**. Chamadas entre serviços **não passam** pelo gateway (DNS interno do cluster) | O gateway é o contrato estável; os serviços internos podem mudar. *Uber DOMA.* (ADR-0013, rev. 03/11) |
| D10 | **Bancos SQL** | **Uma instância RDS por serviço** (`oficina_mecanica` no OS Service, `oficina_billing` numa instância própria do Billing), cada uma com SG e segredo próprios; DynamoDB da Execução acessado por **VPC Gateway Endpoint** com política por tabela (revisado em 04/11, [ADR-0014](arquitetura/adr/ADR-0014-instancia-rds-por-servico-e-endpoint-dynamodb.md)) | "Banco próprio" sem ambiguidade na entrega: isolamento por instância e por rede, não só por grants. Custo extra de uma `db.t3.micro`, aceitável porque a infra é efêmera. |
| D11 | **Repositório do OS Service** | `soat-fiap-oficina-os-service` **evolui para o OS Service** (strangler) e é **renomeado** para `soat-fiap-oficina-os-service`; continua sendo o hub de documentação | O monólito já é 70 % OS Service (CI/CD, EKS, observabilidade, auth prontos). GitHub redireciona a URL antiga (links do PDF da Fase 3 continuam válidos). |
| D12 | **Ambiente local** | `docker-compose.fase4.yml` no hub: 3 serviços + 2 Postgres + DynamoDB Local + mock do Mercado Pago + Lambda local — **sem LocalStack** (revisada em 03/11) | Base dos testes BDD e da demo sem custo de nuvem; os serviços se falam por HTTP na rede do compose. |

---

## Mapeamento dos repositórios (Fase 3 → Fase 4)

| Repositório | Fase 3 | Fase 4 |
|---|---|---|
| `soat-fiap-oficina-auth-lambda` (1) | Lambda auth + authorizer | **Inalterado** (mesmo JWT para os 3 serviços) |
| `soat-fiap-oficina-infra-k8s` (2) | VPC, EKS, gateway, observabilidade | + **`dynamodb/`**, gateway multi-serviço (3 prefixos, inclusive Execução), NLB com 3 listeners, ECR ×3, dashboards do fluxo distribuído. O stage `messaging/` (SNS/SQS/DLQ) foi criado na US-F4-02 e **sai na US-F4-18** |
| `soat-fiap-oficina-infra-db` (3) | RDS + secret | + banco/usuário do **Billing**, secrets por serviço |
| `soat-fiap-oficina-os-service` (4) | monólito + docs | → **`soat-fiap-oficina-os-service`**: OS Service + orquestrador da saga + notificação + **hub de docs/BDD** |
| [`soat-fiap-oficina-billing-service`](https://github.com/guilhermeqmaia/soat-fiap-oficina-billing-service) (5, criado 30/09) | — | Orçamento, aprovação, Mercado Pago, ledger — **Postgres** |
| [`soat-fiap-oficina-execucao-service`](https://github.com/guilhermeqmaia/soat-fiap-oficina-execucao-service) (6, criado 30/09) | — | Fila de execução, diagnóstico, catálogo, estoque — **DynamoDB** |
| [`soat-fiap-oficina-kit`](https://github.com/guilhermeqmaia/soat-fiap-oficina-kit) (7, criado 30/09; **v0.2.1 publicada 20/10**) | — | `@guilhermeqmaia/oficina-kit` + template de serviço + schemas dos eventos + cliente HTTP interno (US-F4-18) |

---

## O fluxo distribuído proposto

> Transporte revisado em 03/11/2026 ([RFC-0008](arquitetura/rfcs/RFC-0008-comunicacao-http-entre-servicos.md)):
> cada **comando** do orquestrador é um **endpoint HTTP** no participante; cada **evento** é a
> resposta síncrona desse endpoint (resultado imediato) ou um **callback HTTP**
> `POST /ordens-servico/{numero}/eventos` no OS Service (depende de pessoa ou do Mercado Pago).
> Os nomes `execucao.*`/`billing.*` continuam como vocabulário. Chamadas entre serviços vão
> pelo DNS interno do cluster, com JWT de serviço; usuários entram pelo gateway. Detalhes em
> [`contratos/http-interno.md`](contratos/http-interno.md).

```mermaid
flowchart LR
    C["Cliente / Staff"] --> GW["API Gateway<br/>(mesmo da Fase 3)"]
    GW -->|/auth| L["Lambda auth"]
    GW -->|/ordens-servico /clientes /veiculos| OS["OS Service<br/>orquestrador da saga<br/><b>Postgres oficina_os</b>"]
    GW -->|/orcamentos /pagamentos<br/>/webhooks/mercadopago| BI["Billing Service<br/><b>Postgres oficina_billing</b>"]
    GW -->|/execucao /catalogo /estoque| EX["Execução Service<br/><b>DynamoDB</b>"]
    OS -->|"HTTP: POST /execucao/ordens, .../iniciar, DELETE"| EX
    OS -->|"HTTP: POST /orcamentos, .../cobrar, DELETE"| BI
    EX -.->|"callback POST /ordens-servico/{n}/eventos"| OS
    BI -.->|"callback POST /ordens-servico/{n}/eventos"| OS
    BI <-->|order / webhook| MP["Mercado Pago"]
    OS -.-> N["Notificação<br/>(webhook / e-mail)"]
    OS & BI & EX -.traces · logs · métricas.-> OBS["Datadog / Prometheus"]
```

### Máquina de estados da OS (Fase 4)

```
RECEBIDA → EM_DIAGNOSTICO → AGUARDANDO_APROVACAO → EM_EXECUCAO → AGUARDANDO_PAGAMENTO → FINALIZADA → ENTREGUE
    └──────────┴──────────────────┴──────────► CANCELADA (com compensações; só até a execução começar)
```

### Saga orquestrada — caminho feliz (HTTP + callbacks)

| Passo | Chamada do OS Service (comando) | Resposta / callback (evento) | Status da OS |
|---|---|---|---|
| 1 | `POST /execucao/ordens` `{ numeroOS, veiculoId, descricaoProblema }` (`execucao.enfileirar`) | `201 { numeroOS, posicaoFila }` ≙ `execucao.enfileirada` | RECEBIDA → EM_DIAGNOSTICO |
| 2 | — (mecânico diagnostica na Execução: `POST /execucao/ordens/{n}/diagnostico`) | callback `execucao.diagnostico-concluido` (itens + preços congelados) | EM_DIAGNOSTICO (snapshot gravado) |
| 3 | `POST /orcamentos` `{ numeroOS, clienteId, itens[] }` (`billing.gerar-orcamento`) | `201 { numeroOS, orcamentoId, total, validoAte }` ≙ `billing.orcamento-gerado` | → AGUARDANDO_APROVACAO (notifica cliente) |
| 4 | — (cliente aprova no Billing: `POST /orcamentos/{n}/aprovar`; sem cobrança) | callback `billing.orcamento-aprovado` | — |
| 5 | `POST /execucao/ordens/{n}/iniciar` (`execucao.iniciar`) | `200 { numeroOS }` ≙ `execucao.iniciada` (baixa de estoque) | → EM_EXECUCAO |
| 6 | — (mecânico finaliza: `POST /execucao/ordens/{n}/finalizar`) | callback `execucao.finalizada` | → AGUARDANDO_PAGAMENTO |
| 7 | `POST /orcamentos/{n}/cobrar` (`billing.cobrar`; Billing cria a order MP) | `201 { numeroOS, orderId, linkPagamento, valor }` ≙ `billing.cobranca-criada` | — (Notificação envia o link) |
| 8 | — (webhook do Mercado Pago no Billing) | callback `billing.pagamento-aprovado` | → FINALIZADA (notifica) |
| 9 | atendente entrega (`POST /ordens-servico/{id}/entregar`) | — | → ENTREGUE |

### Compensações (recuperação para trás)

| Falha | Compensações (chamadas HTTP, ordem inversa) | Final |
|---|---|---|
| Enfileirar recusado (`409` em `POST /execucao/ordens` — veículo já em execução) | — | CANCELADA |
| Orçamento rejeitado pelo cliente (callback `billing.orcamento-rejeitado`) | `DELETE /execucao/ordens/{n}` (`execucao.liberar-reservas`) | CANCELADA |
| Timeout de aprovação | `DELETE /orcamentos/{n}` (`billing.cancelar-orcamento`) · `DELETE /execucao/ordens/{n}` | CANCELADA |
| Falha ao iniciar execução (`409` em `.../iniciar` — estoque insuficiente; aprovado, não pago, não executado) | `DELETE /orcamentos/{n}` · `DELETE /execucao/ordens/{n}` (sem estorno) | CANCELADA |
| Pagamento recusado / em atraso (após a execução) | **nenhuma** — serviço já executado | permanece AGUARDANDO_PAGAMENTO (pendência: alerta + `reprocessar` repete `POST /orcamentos/{n}/cobrar`) |

Os `DELETE` são idempotentes (`200` mesmo sem nada a desfazer) e a saga fica `COMPENSANDO` até as
duas respostas chegarem. Falhas de **plataforma** (serviço fora, timeout de rede, `5xx`) → **retry**
com backoff (3 tentativas: 200 ms, 800 ms, 3 s); esgotado, a saga fica no passo, o alerta de saga
parada dispara e `POST /admin/sagas/:numero/reprocessar` reenvia — recuperação para frente, nunca
compensação. Não há DLQ.

---

## Ondas de execução

### Onda 0 — Decisões, contratos e fundações — 3 dias
US-F4-DOC-01 (RFCs) · US-F4-DOC-02 (ADRs) · US-F4-DOC-03 (AsyncAPI) · criação dos repos 5–7 e convites · **decisão do time sobre D1/D2/D8/D11**.

### Onda 1 — Plataforma — 5 dias
US-F4-01 (kit + template) · ~~US-F4-02 (mensageria)~~ *cancelada em 03/11 — substituída pela US-F4-18* · US-F4-03 (bancos) · US-F4-04 (repos + CI/CD + Sonar) · US-F4-05 (gateway multi-serviço) · **US-F4-18 (comunicação HTTP entre serviços: kit `/http`, OS Service sem outbox/SQS, endpoints e callbacks, infra sem `messaging/`)**.

### Onda 2 — Os três serviços (transações locais + endpoints/callbacks HTTP) — 8 dias
US-F4-06 (OS Service strangler) · US-F4-07 (Execução + DynamoDB, endpoints `/execucao/*` e callbacks) · US-F4-08 (Billing orçamento, endpoints `/orcamentos/*` e callbacks) · US-F4-12 (notificações alimentadas pelos callbacks). *Podem andar em paralelo, um por pessoa; o contrato é `http-interno.md`.*

### Onda 3 — Saga e pagamento — 6 dias
US-F4-10 (orquestrador chamando Execução/Billing por HTTP) · US-F4-11 (compensações por `DELETE` + retry/reprocessar + injeção de falhas) · US-F4-09 (Mercado Pago: `cobrar` + webhook + callback `pagamento-*`).

### Onda 4 — Qualidade — 4 dias
US-F4-13 (cobertura + quality gate) · US-F4-14 (BDD Gherkin + Cucumber — exigência do professor; um `.feature` por fluxo em cada serviço + ponta a ponta no hub) · US-F4-15 (contratos OpenAPI por serviço).

### Onda 5 — Observabilidade distribuída e documentação — 4 dias
US-F4-16 (traces através das chamadas HTTP, dashboards de latência/erro entre serviços, alerta de saga parada) · US-F4-DOC-04 (diagramas) · US-F4-DOC-05 (READMEs) · US-F4-DOC-06 (QA plans).

### Onda 6 — Entrega — 1 dia
US-F4-17 (vídeo + PDF).

**Total: ~31 dias úteis de esforço, ~138 SP** (US-F4-02 cancelada: −5; US-F4-18: +8) — com 4 pessoas e as Ondas 2/3 em paralelo, cabe em ~4 semanas de calendário.

---

## Índice das histórias

| # | História | SP | Onda | Repo |
|---|---|---|---|---|
| US-F4-DOC-01 | [RFCs — decomposição, saga, mensageria, NoSQL](user-stories/f4-doc-01-rfcs.md) | 3 | 0 | hub |
| US-F4-DOC-02 | [ADRs — outbox, kit, SonarCloud, Mercado Pago, gateway](user-stories/f4-doc-02-adrs.md) | 2 | 0 | hub |
| US-F4-DOC-03 | [Contratos de eventos (AsyncAPI)](user-stories/f4-doc-03-contratos-eventos.md) | 3 | 0 | hub |
| US-F4-01 | [Kit compartilhado `@guilhermeqmaia/oficina-kit`](user-stories/f4-01-kit-compartilhado.md) | 8 | 1 | kit |
| ~~US-F4-02~~ | [Mensageria SNS+SQS FIFO com DLQ](user-stories/f4-02-mensageria.md) — **cancelada em 03/11**, substituída pela US-F4-18 | ~~5~~ | 1 | infra-k8s |
| US-F4-03 | [Bancos por serviço (Postgres ×2, DynamoDB)](user-stories/f4-03-bancos-por-servico.md) | 5 | 1 | infra-db / infra-k8s |
| US-F4-04 | [Repos + CI/CD por serviço (Sonar, deploy EKS)](user-stories/f4-04-repos-e-cicd-por-servico.md) | 8 | 1 | todos |
| US-F4-05 | [API Gateway multi-serviço + webhook MP](user-stories/f4-05-gateway-multi-servico.md) | 5 | 1 | infra-k8s |
| US-F4-18 | [Comunicação HTTP entre serviços (kit, OS, Billing, Execução, infra)](user-stories/f4-18-comunicacao-http-entre-servicos.md) — **nova em 03/11**; **encerrada do lado do os-service em 11/11** (contrato `http-interno.md` estável v1.0) | 8 | 1 | kit / os-service / billing / execucao / infra-k8s |
| US-F4-06 | [OS Service — strangler do monólito](user-stories/f4-06-os-service-strangler.md) | 8 | 2 | os-service |
| US-F4-07 | [Execução Service — fila, diagnóstico, catálogo, estoque (DynamoDB)](user-stories/f4-07-execucao-service.md) | 13 | 2 | execucao-service |
| US-F4-08 | [Billing Service — orçamento, aprovação, rejeição](user-stories/f4-08-billing-orcamento.md) | 8 | 2 | billing-service |
| US-F4-12 | [Notificações por eventos](user-stories/f4-12-notificacoes-por-eventos.md) | 3 | 2 | os-service |
| US-F4-09 | [Billing — pagamento Mercado Pago](user-stories/f4-09-billing-mercado-pago.md) | 8 | 3 | billing-service |
| US-F4-10 | [Saga orquestrada da OS](user-stories/f4-10-saga-orquestrada.md) | 13 | 3 | os-service |
| US-F4-11 | [Compensações e rollback seguro](user-stories/f4-11-compensacoes-rollback.md) | 8 | 3 | os/billing/execucao |
| US-F4-13 | [Cobertura ≥ 80 % + quality gate](user-stories/f4-13-cobertura-e-sonar.md) | 5 | 4 | todos |
| US-F4-14 | [BDD dos fluxos (Gherkin + Cucumber — exigência do professor)](user-stories/f4-14-bdd-fluxo-completo.md) | 8 | 4 | hub + serviços |
| US-F4-15 | [Testes de contrato das APIs HTTP (OpenAPI)](user-stories/f4-15-testes-de-contrato.md) — reescrita em 03/11 | 3 | 4 | hub + serviços |
| US-F4-16 | [Observabilidade distribuída (traces HTTP, saga parada)](user-stories/f4-16-observabilidade-distribuida.md) — reescrita em 03/11 | 5 | 5 | kit + infra-k8s |
| US-F4-DOC-04 | [Diagrama geral + sequências da saga](user-stories/f4-doc-04-diagramas.md) | 3 | 5 | hub |
| US-F4-DOC-05 | [READMEs por serviço com evidências](user-stories/f4-doc-05-readmes-por-servico.md) | 3 | 5 | serviços |
| US-F4-DOC-06 | [QA Plans da Fase 4](user-stories/f4-doc-06-qa-plans.md) | 5 | 5 | hub |
| US-F4-17 | [Entrega — vídeo, PDF, diagrama](user-stories/f4-17-entrega-video-pdf.md) | 3 | 6 | hub |

---

### Andamento — US-F4-18 encerrada do lado do os-service (11/11/2026)

Fechada no FLUXO 3 (branch `ci/f4-13-sonarcloud-bdd`): orquestrador por HTTP, callbacks com
dedup, retry esgotado → saga parada → reprocessar, mensageria removida, provados por unit,
integração, contratos e Cucumber de serviço e **ponta a ponta entre containers**
(`docker-compose.fase4.yml` com stubs que validam contra `docs/contratos/schemas`).
`docs/contratos/http-interno.md` está **estável (v1.0)**: daqui em diante só mudança compatível
(ver o bloco de status do documento). Continua aberto na story: lado do **Billing** e da
**Execução** (FLUXOS 1 e 2), repetir o BDD ponta a ponta com as imagens reais
(`BDD_E2E_REAIS=1`) e os cenários de infra/EKS (TS-10..TS-12 do
[`QA_PLAN_US-F4-18.md`](qa-plans/QA_PLAN_US-F4-18.md)). Plano do fluxo:
[`QA_PLAN_FLUXO-3.md`](qa-plans/QA_PLAN_FLUXO-3.md).

---

## Estado do projeto no início da Fase 4

### Pronto (herdado da Fase 3) — reaproveitado sem mudança
- API Gateway + Lambda de auth + authorizer; JWT validado como resource server (`src/auth/` → vai para o kit).
- EKS, VPC, RDS, ECR, Terraform em 3 repos; scripts `aws-deploy-all/pause/resume/destroy`.
- CI/CD com OIDC, branch protection, CODEOWNERS, template de PR (padrão para os repos novos).
- Observabilidade: logs JSON + correlação, `/metrics`, APM, dashboards e alertas como código.
- **Eventos de domínio já existem** (`OsStatusAlterado`, `OrcamentoPronto`, `OsFinalizada`, `OsAcao`, `EstoqueBaixo`) com listeners `@OnEvent` — a ADR-0001 já os declarou "candidatos a evento de broker".
- SonarQube local (`infra/sonar/`), seeds, k6, docs e QA plans.

### Parcialmente pronto (evoluir)
- **Monólito → OS Service**: remover `produto`, `servico`, casos de uso de execução/orçamento; novo status `AGUARDANDO_PAGAMENTO`. *(Feito na US-F4-06 com outbox/SQS; a US-F4-18 troca o transporte por HTTP.)*
- **Orçamento**: hoje é calculado dentro da OS (`calcular-orcamento`); vira agregado do Billing com preços congelados.
- **Estoque**: reservas/baixas existem em Postgres; migram para DynamoDB com *conditional writes*.
- **Gateway**: uma rota catch-all → passa a rotear por prefixo para 3 backends.

### Não iniciado
- Cliente HTTP interno do kit, endpoints/callbacks da Execução e do Billing, JWT de serviço (US-F4-18). *(SNS/SQS, outbox e DLQ foram implementados e depois descartados em 03/11.)*
- Saga (orquestrador, compensações, timeouts, estado consultável).
- Mercado Pago (API de Orders, webhook assinado, reconciliação).
- DynamoDB, kit compartilhado, SonarCloud, BDD (Cucumber), testes de contrato.
- Trace através das chamadas HTTP entre serviços; dashboards do fluxo distribuído.

---

## Riscos e custos

| Risco | Mitigação |
|---|---|
| **Custo AWS** sobe (3 deployments, 2 bancos, DynamoDB) | DynamoDB no free tier; sem SNS/SQS desde 03/11; duas `db.t3.micro` (uma por serviço SQL) só nas janelas de demo; `aws-pause.sh` entre sessões; orçamento de US$ 20/mês com alerta |
| **Escopo grande** (~131 SP) | Ondas 2/3 paralelizáveis por pessoa; kit reduz retrabalho; strangler evita reescrever o OS |
| **Consistência eventual confunde na demo** | `GET /ordens-servico/:n/saga` mostra a linha do tempo; dashboard "Fluxo distribuído"; roteiro do vídeo por passos |
| **Webhook do Mercado Pago em ambiente efêmero** | URL pública do gateway configurada no webhook da aplicação (painel do Mercado Pago); job de reconciliação cobre webhook perdido; mock (WireMock) no compose |
| **Trace não atravessa as chamadas entre serviços** | `traceparent` e `x-correlation-id` propagados pelo cliente HTTP do kit e aceitos pelo callback (US-F4-16) |
| **Participante fora do ar numa chamada síncrona** | retry/backoff no kit; saga fica no passo; alerta de saga parada; `reprocessar` (RFC-0008) |
| **Migração de dados** | Não há produção real: seeds recriados por serviço; o ambiente da Fase 3 já foi destruído |

---

## Checklist de entrega (enunciado)

- [ ] ≥ 3 microsserviços em repositórios próprios, com infraestrutura e banco próprios
- [ ] ≥ 1 banco SQL e ≥ 1 NoSQL; nenhum acesso cruzado a banco
- [ ] Comunicação entre serviços: HTTP síncrono + callbacks (RFC-0008; mensageria descartada em 03/11 com justificativa)
- [ ] Saga com rollback/compensação; escolha justificada no README
- [ ] Unitários em todos; ≥ 80 % por serviço; BDD com Gherkin + Cucumber (exigência do professor: um `.feature` por fluxo em cada serviço + ponta a ponta); SonarCloud no CI
- [ ] CI/CD independente por serviço com deploy no EKS; `main` protegida com checagens
- [ ] Observabilidade da Fase 3 cobrindo o fluxo distribuído
- [ ] Repos com Dockerfile, manifestos, pipelines, evidências de cobertura, arquitetura do serviço, Swagger
- [ ] Vídeo ≤ 15 min (fluxo completo, saga com falha, deploy com testes, rastreamento)
- [ ] PDF (participantes, links, vídeo, diagrama geral, estratégia de saga, justificativas)
