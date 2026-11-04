# Oficina Mecânica — API

[![CI/CD](https://github.com/guilhermeqmaia/soat-fiap-oficina-os-service/actions/workflows/ci-cd.yml/badge.svg?branch=main)](https://github.com/guilhermeqmaia/soat-fiap-oficina-os-service/actions/workflows/ci-cd.yml) [![CD AWS](https://github.com/guilhermeqmaia/soat-fiap-oficina-os-service/actions/workflows/cd-aws.yml/badge.svg?branch=main)](https://github.com/guilhermeqmaia/soat-fiap-oficina-os-service/actions/workflows/cd-aws.yml) [![Perf nightly](https://github.com/guilhermeqmaia/soat-fiap-oficina-os-service/actions/workflows/perf-nightly.yml/badge.svg?branch=main)](https://github.com/guilhermeqmaia/soat-fiap-oficina-os-service/actions/workflows/perf-nightly.yml)

Back-end MVP para sistema integrado de oficina mecânica, focado em gestão de ordens de serviço, clientes, veículos e peças.

**Stack:** NestJS · TypeScript · Prisma · PostgreSQL · Docker · Kubernetes · Terraform · JWT

---

## Fase 3 — Nuvem, Segurança e Observabilidade

A Fase 3 leva a solução da Fase 2 para a **AWS**: autenticação serverless por
CPF (Lambda) atrás de um **API Gateway**, monólito no **EKS**, banco **RDS
PostgreSQL**, segregação em **4 repositórios** com CI/CD independente e
observabilidade com **Datadog**. Plano completo em
[`docs/plano-execucao-fase-3.md`](docs/plano-execucao-fase-3.md).

### Desenho da arquitetura (Fase 3)

Diagrama de **componentes (visão de nuvem)**, diagramas de **sequência**
(autenticação por CPF e abertura de OS) e **fluxo de deploy dos 4 repositórios**,
com legenda linkando cada decisão às RFCs/ADRs (renderizados pelo GitHub):

➡️ **[docs/arquitetura/arquitetura-fase3.md](docs/arquitetura/arquitetura-fase3.md)**

### Onde este repositório entra

```mermaid
flowchart LR
    C["Cliente / Staff"] --> GW["API Gateway<br/>(repo 2)"]
    GW -->|POST /auth| L["Lambda de CPF<br/>(repo 1)"]
    GW -->|VPC Link| APP["**Aplicação NestJS**<br/>(este repo)"]
    APP --> DB[("RDS PostgreSQL<br/>(repo 3)")]
    L --> DB
    APP -.métricas/traces.-> OBS["Datadog<br/>(repo 2)"]
    style APP fill:#e3f2fd,stroke:#1565c0,stroke-width:3px
```

| Repositório | Papel |
|---|---|
| [1 · auth-lambda](https://github.com/guilhermeqmaia/soat-fiap-oficina-auth-lambda) | emite o JWT (CPF) e valida no gateway |
| [2 · infra-k8s](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-k8s) | API Gateway, cluster EKS e observabilidade |
| [3 · infra-db](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-db) | RDS PostgreSQL gerenciado |
| **4 · este repo** | **API NestJS, manifestos K8s e documentação da arquitetura** |

> **Próxima fase:** o planejamento da Fase 4 (microsserviços + saga) está em [`docs/plano-execucao-fase-4.md`](docs/plano-execucao-fase-4.md).

### Entregáveis da Fase 3

| Entregável | Onde |
|---|---|
| Desenho da arquitetura (componentes, sequência, deploy) | [`docs/arquitetura/arquitetura-fase3.md`](docs/arquitetura/arquitetura-fase3.md) |
| RFCs (nuvem, banco, autenticação) | [`docs/arquitetura/rfcs/`](docs/arquitetura/rfcs/README.md) |
| ADRs (comunicação, HPA, resource server, observabilidade, gateway, 4 repos) | [`docs/arquitetura/adr/`](docs/arquitetura/adr/README.md) |
| Justificativa do banco + modelo ER | [`docs/arquitetura/banco-de-dados.md`](docs/arquitetura/banco-de-dados.md) |
| Autenticação serverless por CPF (Lambda + Authorizer) | repo [soat-fiap-oficina-auth-lambda](https://github.com/guilhermeqmaia/soat-fiap-oficina-auth-lambda) |
| API Gateway, cluster EKS e observabilidade (Terraform) | repo [soat-fiap-oficina-infra-k8s](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-k8s) |
| Banco gerenciado RDS (Terraform) | repo [soat-fiap-oficina-infra-db](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-db) |
| App como resource server (valida o JWT da Lambda) | [`@guilhermeqmaia/oficina-kit/auth`](https://github.com/guilhermeqmaia/soat-fiap-oficina-kit) (extraído na Fase 4) · [US-F3-03](docs/user-stories/f3-03-app-resource-server.md) |
| Manifestos de deploy no EKS | [`k8s-aws/`](k8s-aws/README.md) |
| CI/CD com deploy automático (4 repos) | [`.github/workflows/cd-aws.yml`](.github/workflows/cd-aws.yml) + workflows de cada repo |
| Logs estruturados JSON + correlação trace↔log | [`@guilhermeqmaia/oficina-kit/logging`](https://github.com/guilhermeqmaia/soat-fiap-oficina-kit) · [US-F3-09](docs/user-stories/f3-09-logs-estruturados-correlacao.md) |
| Métricas, APM e `/metrics` (OpenMetrics) | [`@guilhermeqmaia/oficina-kit/metrics`](https://github.com/guilhermeqmaia/soat-fiap-oficina-kit) + [`src/observabilidade/`](src/observabilidade) (métricas de negócio) · [US-F3-10](docs/user-stories/f3-10-observabilidade-apm.md) |
| Dashboards e alertas como código | [infra-k8s/observability](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-k8s/tree/main/observability) |
| QA Plans (Fase 3 + backfill + integração) | [`docs/qa-plans/`](docs/qa-plans/README.md) |
| Índice de toda a documentação | [`docs/README.md`](docs/README.md) |
| Documento de entrega (links, evidências, vídeo) | [`docs/entrega-fase-3.md`](docs/entrega-fase-3.md) |
| Vídeo demonstrativo (≤15 min) | _pendente — gravado após o apply na AWS (sessão do Learner Lab)_ |

---

## Fase 2 — Qualidade, Resiliência e Escalabilidade

A Fase 2 evolui o MVP da Fase 1 para **qualidade, resiliência e escalabilidade**,
incorporando práticas modernas de infraestrutura e automação:

- **Refatoração** do código aplicando **Clean Code** e **Clean Architecture** —
  camadas Domain/Application/Infrastructure com dependências apontando para o
  domínio, garantidas por teste automatizado (`src/shared/architecture.spec.ts`).
- **APIs** de abertura de OS, consulta de status, **listagem ordenada por
  prioridade de status** e **webhook externo de aprovação/reprovação** de orçamento.
- **Notificação externa** de mudança de status via **webhook outbound** (HMAC).
- **Containerização** revisada (Dockerfile multi-stage não-root + docker-compose).
- **Orquestração Kubernetes** com Deployments, Services, ConfigMaps, Secrets e
  **HPA** (autoescalonamento por CPU/memória).
- **Infraestrutura como Código** com **Terraform** provisionando cluster + banco.
- **CI/CD** que builda, testa, empacota a imagem e faz deploy ponta-a-ponta em um
  cluster Kubernetes.

### Desenho da arquitetura

Diagramas de **componentes da aplicação**, **infraestrutura provisionada** e
**fluxo de deploy** (renderizados pelo GitHub):

➡️ **[docs/arquitetura/arquitetura-fase2.md](docs/arquitetura/arquitetura-fase2.md)**
(evolução para a nuvem em [arquitetura-fase3.md](docs/arquitetura/arquitetura-fase3.md))

### Entregáveis da Fase 2

| Entregável | Onde |
|---|---|
| Desenho da arquitetura | [`docs/arquitetura/arquitetura-fase2.md`](docs/arquitetura/arquitetura-fase2.md) |
| Manifestos Kubernetes | [`k8s/`](k8s) · [`k8s/README.md`](k8s/README.md) |
| Scripts Terraform (IaC) | [`infra/terraform/`](infra/terraform) · [`infra/terraform/README.md`](infra/terraform/README.md) |
| Pipeline CI/CD (Fase 2 — kind) | [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) |
| Pipeline CD AWS (Fase 3 — ECR + EKS) | [`.github/workflows/cd-aws.yml`](.github/workflows/cd-aws.yml) |
| Manifestos de deploy no EKS (Fase 3) | [`k8s-aws/`](k8s-aws/README.md) |
| Testes de carga / escalabilidade | [`perf/`](perf) · [`perf/README.md`](perf/README.md) |
| Collection das APIs (Swagger/OpenAPI) | `http://localhost:3000/api` (com a app rodando) — ver [Collection das APIs](#collection-das-apis) |
| Vídeo demonstrativo (≤15 min) | https://drive.google.com/file/d/1K5Qihz4IGKitT791J9-3o77F8kg_ujvd/view |

---

## Pré-requisitos

- [Node.js 20+](https://nodejs.org/)
- [Docker](https://www.docker.com/) e Docker Compose

---

## Rodando com Docker Compose (recomendado)

Sobe a aplicação e o banco de dados juntos. **As migrations (incluindo a migration de seed dos usuários de teste) são aplicadas automaticamente na inicialização do container.**

```bash
# 1. Clone o repositório
git clone <url-do-repositorio>
cd software-architecture-tech-challenge-01

# 2. Configure o .env (JWT_SECRET é obrigatória)
cp .env.example .env

# 3. Suba os containers
docker compose up -d

# 4. Acompanhe os logs (opcional)
docker compose logs -f app
```

A API estará disponível em `http://localhost:3000`.
A documentação Swagger estará em `http://localhost:3000/api`.

### Parar os containers

```bash
docker compose down
```

Para remover também o volume do banco de dados:

```bash
docker compose down -v
```

---

## Variáveis de ambiente

Copie `.env.example` para `.env` (usado apenas em execução local sem Docker):

```bash
cp .env.example .env
```

| Variável | Descrição | Default |
|---|---|---|
| `DATABASE_URL` | String de conexão PostgreSQL | `postgresql://postgres:postgres@localhost:5432/oficina_mecanica?schema=public` |
| `PORT` | Porta da API | `3000` |
| `JWT_SECRET` | **Obrigatória.** Chave secreta do JWT | — (a app falha em iniciar sem esta variável) |
| `JWT_ISSUER` | Claim `iss` aceita nos tokens (emissor = Lambda de CPF) | `oficina-auth-lambda` |
| `PUBLIC_BASE_URL` | URL pública usada nos links enviados em notificações | `http://localhost:3000` |
| `NOTIFICATION_PROVIDER` | Adapter de notificação: `mock` ou `webhook`. Sem valor, usa `mock` em desenvolvimento e `webhook` em produção | `mock` em dev, `webhook` em prod |
| `NOTIFICATION_WEBHOOK_URL` | URL de destino do POST outbound de notificação. Para demo, use uma URL de `https://webhook.site/` ou RequestBin | — |
| `NOTIFICATION_WEBHOOK_SECRET` | Segredo usado para gerar o header `X-Signature: sha256=<hmac>` com HMAC-SHA256 do body | — |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | Timeout do POST outbound | `5000` |
| `LOG_LEVEL` | Nivel do logger estruturado: `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent` | `debug` fora de producao, `info` em producao |
| `EXECUCAO_SERVICE_URL` | Base interna do Execução Service (chamadas da saga, RFC-0008). **Obrigatória em produção** | `http://localhost:3002` |
| `BILLING_SERVICE_URL` | Base interna do Billing Service. **Obrigatória em produção** | `http://localhost:3001` |
| `HTTP_INTERNO_TIMEOUT_MS` / `HTTP_INTERNO_TENTATIVAS` | Timeout por tentativa e tentativas do cliente HTTP interno | `5000` / `3` |
| `CALLBACKS_RETENCAO_DIAS` | Retenção dos ids de callback em `processed_messages` (purga horária) | `7` |

> **Importante:** `JWT_SECRET` é obrigatória. Antes de subir os containers, copie `.env.example` para `.env` ou defina a variável no seu shell. Exemplo:
>
> ```bash
> cp .env.example .env
> # edite .env e coloque um valor forte em JWT_SECRET
> ```

### Notificação por webhook outbound

Para demonstrar notificações sem infraestrutura própria de e-mail/SMS/push, a aplicação pode publicar mudanças de status da OS em um webhook externo.

1. Abra `https://webhook.site/` ou um RequestBin e copie a URL gerada.
2. Configure o `.env`:

```bash
NOTIFICATION_PROVIDER=webhook
NOTIFICATION_WEBHOOK_URL=https://webhook.site/<token-gerado>
NOTIFICATION_WEBHOOK_SECRET=segredo-usado-no-video
NOTIFICATION_WEBHOOK_TIMEOUT_MS=5000
```

Quando a OS mudar de status, a API envia `POST` com `Content-Type: application/json` e `X-Signature: sha256=<hmac>`. O body contém `ordemId`, `clienteId`, `statusAnterior`, `statusAtual`, `timestamp` e `tipoNotificacao`. Falhas de entrega, timeout e respostas 4xx/5xx são registradas em log e não bloqueiam o fluxo principal da OS. O POST outbound propaga o `X-Correlation-Id` da requisição de origem, para correlacionar a notificação recebida pelo webhook com a requisição que a disparou.

---

## Logs estruturados e correlação (US-F3-09)

A aplicação usa [`nestjs-pino`](https://github.com/iamolegga/nestjs-pino) e emite **JSON** em todos os ambientes (`stdout`), pronto para ingestão por qualquer backend de logs (CloudWatch, Loki, ELK etc. — ver [US-F3-10](docs/user-stories/f3-10-observabilidade-apm.md)).

Cada linha de log de requisição tem o formato:

```json
{
  "level": 30,
  "time": 1732300800000,
  "correlationId": "9f1c9e2a-...",
  "traceId": "9f1c9e2a-...",
  "method": "POST",
  "path": "/ordens-servico",
  "statusCode": 201,
  "latencyMs": 42,
  "userId": "usr_123",
  "role": "ATENDENTE",
  "msg": "POST /ordens-servico -> 201"
}
```

- **Correlation ID por requisição**: resolvido a partir do primeiro header presente, em ordem — `X-Correlation-Id` → `X-Request-Id` (padrão de proxies/API Gateway) → trace-id do `traceparent` (W3C Trace Context) → `Root` do `X-Amzn-Trace-Id` (AWS API Gateway / ALB) → gera um UUID v4 novo. Devolvido no header de resposta `X-Correlation-Id` e propagado para todo log emitido durante a requisição (services, listeners de eventos de domínio) via `AsyncLocalStorage`, além de para chamadas outbound (webhook de notificação) via header `X-Correlation-Id`.
- **traceId** (correlação log ↔ APM — [US-F3-10](docs/user-stories/f3-10-observabilidade-apm.md)): quando há um span de APM ativo (`dd-trace`, ligado por `DD_TRACE_ENABLED`), vem do **id real do trace** e os campos `dd.trace_id`/`dd.span_id` são emitidos no log — formato que o pipeline do Datadog casa automaticamente com o trace. Sem APM local, usa o trace vindo da borda (`traceparent` → `x-datadog-trace-id` → `X-Amzn-Trace-Id`) e, na ausência de qualquer um, o próprio `correlationId`. Com APM ativo, o `correlationId` também é gravado como tag `correlation_id` no span, habilitando o pivô **trace → logs** no painel.
- **Nível por ambiente**: `debug` fora de produção, `info` em produção — sobrescrevível via `LOG_LEVEL`. Em `NODE_ENV=test` o logger fica silencioso.
- **Sem dados sensíveis**: `authorization`, `cookie` e chaves como `password`/`senha`/`token`/`secret` são redigidos (`[REDACTED]`) em qualquer objeto logado; mensagens de erro de domínio que interpolam CPF/CNPJ (ex.: `DuplicateCpfCnpjError`) são mascaradas automaticamente (`529******25`) antes de irem para o log.
- **Erros logados com contexto**: `DomainError` (`DomainExceptionFilter` do kit, `@guilhermeqmaia/oficina-kit/core`) e exceções não tratadas são logados com `correlationId`, `kind`/tipo e path — insumo para o alerta de falha de OS ([US-F3-11](docs/user-stories/f3-11-dashboards-alertas.md)).

**Como consultar por correlationId**: pegue o valor do header `X-Correlation-Id` na resposta (ou do log do cliente) e filtre o backend de logs por `correlationId:"<valor>"` — todas as linhas da mesma requisição, em qualquer camada, carregam o mesmo valor.

Código-fonte: `@guilhermeqmaia/oficina-kit/logging` ([repo do kit](https://github.com/guilhermeqmaia/soat-fiap-oficina-kit)) — contexto de correlação, resolução do ID, configuração do pino e `CorrelationIdMiddleware`; desde a Fase 4 esse código é compartilhado pelos três microsserviços (ADR-0010).

---

## Autenticação

A API usa JWT para proteger endpoints administrativos. Endpoints marcados com `@Public()` não requerem autenticação.

### Usuários de teste (apenas desenvolvimento)

> ⚠️ **Somente para desenvolvimento.** Estes usuários têm senhas conhecidas e
> **nunca** devem existir em produção. Eles **não** são mais criados pelas
> migrations (`prisma migrate deploy` não semeia nada). Para popular um banco de
> dev com dados de demonstração + estes usuários, rode:
>
> ```bash
> npm run seed   # recusa rodar com NODE_ENV=production
> ```
>
> Em produção, crie o administrador inicial por um canal seguro/manual.

| Role | CPF (dev) | Senha (dev) |
|---|---|---|
| ADMIN | `529.982.247-25` | `admin123` |
| ATENDENTE | `248.301.457-73` | `atendente123` |
| MECANICO | `168.995.350-09` | `mecanico123` |
| ESTOQUISTA | `746.824.883-41` | `estoquista123` |
| CLIENTE | `390.533.447-05` | — (cliente autentica só com CPF) |

### Fazendo login (Fase 3 — resource server)

**A aplicação não emite mais tokens** ([US-F3-03](docs/user-stories/f3-03-app-resource-server.md)):
o login é por **CPF** na Lambda atrás do API Gateway
(repo [soat-fiap-oficina-auth-lambda](https://github.com/guilhermeqmaia/soat-fiap-oficina-auth-lambda)).

```bash
# Cliente (só CPF) / Staff (CPF + senha) — na URL pública do gateway:
curl -X POST "$GATEWAY_URL/auth" -H "Content-Type: application/json" \
  -d '{"cpf":"529.982.247-25","senha":"admin123"}'
```

**Desenvolvimento local** (sem gateway): gere um token com o mesmo `JWT_SECRET`:

```bash
node -e "console.log(require('jsonwebtoken').sign(
  { cpf: '52998224725', nome: 'Admin', role: 'ADMIN' },
  process.env.JWT_SECRET,
  { algorithm: 'HS256', subject: 'dev-admin', issuer: 'oficina-auth-lambda', expiresIn: 3600 }
))"
```

### Usando o token

Inclua o header `Authorization: Bearer <token>` nas requisições a endpoints protegidos:

```bash
curl http://localhost:3000/auth/me \
  -H "Authorization: Bearer <token>"
```

No Swagger (`http://localhost:3000/api`), clique em **Authorize** e cole o token.

---

## Rodando localmente (sem Docker)

### 1. Instale as dependências

```bash
npm install
```

### 2. Configure as variáveis de ambiente

```bash
cp .env.example .env
```

### 3. Suba apenas o banco de dados

```bash
docker compose up -d postgres
```

### 4. Execute as migrations

```bash
npm run prisma:migrate
```

> A migration `99999999999999_seed_test_users` já popula os usuários de teste automaticamente.

### 5. Inicie a aplicação

```bash
# Desenvolvimento (com hot reload)
npm run start:dev

# Produção
npm run build
npm start
```

A API estará disponível em `http://localhost:3000`.
A documentação Swagger estará em `http://localhost:3000/api`.

---

## Subir tudo localmente (kind) com um comando

Para desenvolvimento/demonstração, um script executa **todo o fluxo de ponta a
ponta** em um cluster [kind](https://kind.sigs.k8s.io/) local: provisiona
**cluster + banco** (Terraform), **builda** as imagens da API e das duas UIs,
carrega no cluster, aplica os **manifestos**, roda as **migrations**, aplica os
**seeds** de demonstração e instala o **metrics-server** (necessário para o HPA).

```bash
# Pré-requisitos: docker, kubectl e terraform (o kind é instalado via Homebrew se faltar)
bash scripts/local-k8s-up.sh
```

Em outro terminal, abra os acessos (mantém os `port-forward` ativos):

```bash
bash scripts/local-k8s-forward.sh
# API:     http://localhost:3000   (Swagger em /api quando NODE_ENV != production)
# Admin:   http://localhost:8080
# Cliente: http://localhost:8081
```

> Para usar o `kubectl` manualmente neste cluster:
> `export KUBECONFIG=$HOME/.kube/oficina-mecanica.config` (contexto
> `kind-oficina-local`). As duas seções a seguir detalham **o mesmo fluxo passo a
> passo** — úteis para entender o que o script faz ou para rodar de forma manual.

---

## Provisionamento da infraestrutura com Terraform

> **Fase 2 (legado local).** Este Terraform sobe um cluster **kind** com Postgres
> in-cluster para a demo local. Na **Fase 3** a infraestrutura de nuvem vive nos
> repositórios dedicados: [infra-k8s](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-k8s)
> (VPC, EKS, API Gateway, observabilidade) e
> [infra-db](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-db) (RDS).

O Terraform provisiona o **cluster Kubernetes** e o **banco de dados** em dois
estágios. Detalhes em [`infra/terraform/README.md`](infra/terraform/README.md).

```bash
# Pré-requisitos: terraform >= 1.9, docker e kubectl

# Estágio 1 — cria o cluster kind e escreve o kubeconfig
cd infra/terraform/01-cluster
terraform init
terraform apply            # gera ~/.kube/oficina-mecanica.config

# Estágio 2 — cria o Postgres e o Secret oficina-db (DATABASE_URL)
cd ../02-app
terraform init
terraform apply            # senha do banco gerada via random_password
```

Recursos criados (resumo): `kind_cluster`, `kubernetes_namespace`, Postgres
(`PVC` + `Deployment` + `Service`), `random_password` e `kubernetes_secret`
(`oficina-db`). Ver a tabela completa em
[docs/arquitetura/arquitetura-fase2.md](docs/arquitetura/arquitetura-fase2.md#recursos-criados-pelo-terraform).

---

## Deploy em Kubernetes

Os manifestos da aplicação estão em [`k8s/`](k8s) (Kustomize). Detalhes em
[`k8s/README.md`](k8s/README.md).

> Para rodar todo este fluxo de uma vez em um cluster kind local, use
> `bash scripts/local-k8s-up.sh` (ver [Subir tudo localmente (kind) com um
> comando](#subir-tudo-localmente-kind-com-um-comando)). Os passos abaixo são o
> mesmo fluxo, manual.

```bash
# Aponte o kubectl para o cluster provisionado pelo Terraform
export KUBECONFIG=$HOME/.kube/oficina-mecanica.config

# Crie o Secret da aplicação a partir do exemplo (JWT + tokens de webhook)
cp k8s/secret.yaml.example k8s/secret.yaml   # edite os valores

# (kind) carregue a imagem no cluster (nome do cluster: oficina-local)
kind load docker-image oficina-mecanica-app:latest --name oficina-local

# Aplique todos os manifestos (namespace, configmap, secret, migrations, app, service, hpa)
kubectl apply -k k8s/

# Acompanhe o Job de migrations e o rollout
kubectl wait --for=condition=complete job/oficina-migrations -n oficina --timeout=180s
kubectl rollout status deployment/oficina-app -n oficina

# HPA (requer metrics-server no cluster)
kubectl get hpa -n oficina
```

O deploy contempla **Deployment** (2 réplicas, probes, requests/limits),
**Service** (ClusterIP), **ConfigMap** + **Secret**, **Job de migrations**
(`prisma migrate deploy`) e **HPA** (CPU 70% / memória 80%, min 2 / máx 10).

> O mesmo fluxo (Terraform → imagem → `kubectl apply -k`) roda automaticamente no
> pipeline [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) contra um
> cluster kind efêmero, com smoke test em `/health`.

---

## Collection das APIs

A API é documentada via **Swagger/OpenAPI**. Com a aplicação rodando:

- **Swagger UI:** `http://localhost:3000/api`
- **OpenAPI JSON:** `http://localhost:3000/api-json` (importável no Postman/Insomnia)

Exemplos de `curl` prontos por domínio em [`docs/`](docs):
[cliente](docs/curls-cliente.md) · [veículo](docs/curls-veiculo.md) ·
[ordem de serviço](docs/curls-ordem-servico.md) · [usuário](docs/curls-usuario.md).

---

## Vídeo demonstrativo

**Fase 2:** https://drive.google.com/file/d/1K5Qihz4IGKitT791J9-3o77F8kg_ujvd/view

**Fase 3 (≤15 min):** roteiro e link em [`docs/entrega-fase-3.md`](docs/entrega-fase-3.md)
— autenticação por CPF via gateway, pipeline CI/CD, deploy automático na AWS,
consumo das APIs protegidas, dashboard ao vivo e logs/traces correlacionados.
_Link publicado após a gravação (depende do apply na AWS)._

---

## Testes

```bash
# Todos os testes (unit + integração + e2e)
npm test

# Com cobertura
npm run test:cov

# Apenas testes unitários
npx jest --testPathIgnorePatterns=integration --testPathIgnorePatterns=e2e

# Apenas testes de integração (requer Docker)
npx jest integration

# Apenas testes e2e (requer Docker)
npx jest e2e
```

Os testes de integração e e2e usam [testcontainers](https://node.testcontainers.org/) para subir uma instância PostgreSQL efêmera — não há dependência de banco externo rodando.

---

## Scripts disponíveis

| Comando | Descrição |
|---|---|
| `npm run start:dev` | Inicia em modo desenvolvimento com hot reload |
| `npm run build` | Compila o TypeScript |
| `npm start` | Inicia a versão compilada |
| `npm test` | Executa todos os testes |
| `npm run test:cov` | Executa os testes com cobertura |
| `npm run prisma:generate` | Gera o cliente Prisma |
| `npm run prisma:migrate` | Cria e aplica migrations (dev) |
| `npm run prisma:deploy` | Aplica migrations (produção) |
| `npm run docker:up` | Sobe os containers |
| `npm run docker:down` | Para os containers |

---

## Estrutura do projeto

```
src/
├── main.ts                   # Bootstrap da aplicação
├── app.module.ts             # Módulo raiz
├── prisma/                   # PrismaService global
├── shared/                   # Base DDD + architecture.spec.ts (regra de dependência)
├── auth/                     # Bounded Context: Autenticação (Usuario, JWT)
│   ├── domain/               # Entidade, Role, Value Objects, errors
│   ├── application/          # Use Cases + ports/gateways
│   └── infrastructure/       # Controller, guards, strategies, adapters
├── usuario/                  # Bounded Context: Usuários
├── cliente/                  # Bounded Context: Atendimento (Cliente)
├── veiculo/                  # Bounded Context: Atendimento (Veículo)
├── ordem-de-servico/         # Bounded Context: Atendimento (OrdemDeServico — aggregate root)
│   ├── application/use-cases/transicoes/  # Transições dirigidas por eventos (Execução/Billing)
│   └── saga/                 # Orquestrador, participantes por HTTP e callbacks (RFC-0005/RFC-0008)
├── notificacao/              # Bounded Context: Notificação (webhook outbound)
├── health/                   # Health/readiness checks
└── test/                     # Helpers compartilhados de teste

k8s/                          # Manifestos Kubernetes (Kustomize)
infra/terraform/              # IaC — cluster (01) + banco (02)
perf/                         # Testes de carga, estresse e escalabilidade (HPA)
```

Cada bounded context segue a estrutura DDD em camadas: **Domain → Application → Infrastructure**,
com as dependências apontando para o domínio (Clean Architecture).

> **Fase 4 (US-F4-06):** este repositório é o **OS Service**. Catálogo (`servico`) e Estoque
> (`produto`) migraram para o Execução Service; orçamento, aprovação e pagamento para o Billing.
> A OS guarda um *snapshot* dos itens (nome, quantidade, preço) recebido por evento e expõe só
> abertura, consulta, entrega e cancelamento. Ver
> [docs/user-stories/f4-06-os-service-strangler.md](docs/user-stories/f4-06-os-service-strangler.md).

---

## Comunicação entre serviços (HTTP — Fase 4, US-F4-18)

Desde 03/11/2026 o OS Service fala com a Execução e o Billing por **HTTP direto** (RFC-0008; a mensageria
SNS/SQS da US-F4-06 foi removida). As chamadas vão pelo DNS interno do cluster
(`EXECUCAO_SERVICE_URL=http://execucao-service:3002`, `BILLING_SERVICE_URL=http://billing-service:3001`),
sem passar pelo API Gateway, com o `ClienteHttpInterno` do kit (`@guilhermeqmaia/oficina-kit/http`): JWT de
serviço (`role: SERVICO`, mesmo `JWT_SECRET` da Lambda), `x-correlation-id` = número da OS, timeout de 5 s e
3 tentativas com backoff (200 ms, 800 ms, 3 s) só para 5xx/timeout/rede. A **resposta síncrona** de cada
comando vira o evento da saga (`201` ≙ sucesso, `409 { motivo }` ≙ recusa); o que depende de uma pessoa ou do
Mercado Pago chega por **callback** em `POST /ordens-servico/:numero/eventos` (role `SERVICO`, envelope com
`id` uuid, `type`, `version`, `occurredAt`, `producer`, `data`), deduplicado pelo `id` em `processed_messages`
(`200 { aplicado: false, duplicado: true }` na repetição). A especificação completa — endpoints, respostas,
callbacks, retry, idempotência — está em [`docs/contratos/http-interno.md`](docs/contratos/http-interno.md).

---

## Saga orquestrada (Fase 4 — US-F4-10)

O ciclo de vida da OS atravessa três serviços e três bancos; a consistência é garantida por uma
**saga orquestrada**, com o orquestrador dentro do OS Service (decisão e justificativa na
[RFC-0005](docs/arquitetura/rfcs/RFC-0005-estrategia-de-saga.md): o OS Service já é o dono da
máquina de estados da OS, o fluxo tem 9 passos e 4 cenários de compensação cruzada, e o estado
precisa ser explícito e consultável).

- **Estado persistido** em `saga_os` (passo, status, histórico, compensações, prazos) e exposto em
  `GET /ordens-servico/numero/:numero/saga`.
- **Passos:** `ENFILEIRAR_EXECUCAO → AGUARDAR_DIAGNOSTICO → GERAR_ORCAMENTO → AGUARDAR_APROVACAO →
  INICIAR_EXECUCAO → AGUARDAR_FINALIZACAO → COBRAR → AGUARDAR_PAGAMENTO → CONCLUIDA`. Cada passo envia um
  **comando por HTTP** (`POST /execucao/ordens`, `POST /orcamentos`, `POST /execucao/ordens/{n}/iniciar`,
  `POST /orcamentos/{n}/cobrar`) **depois do commit** da transação que o decidiu, e a resposta síncrona é
  reinjetada como o **evento** esperado (`execucao.enfileirada`, `billing.orcamento-gerado`, `execucao.iniciada`,
  `billing.cobranca-criada`) numa nova transação; duplicados e fora de ordem são ignorados e registrados.
  O que depende de pessoa/Mercado Pago chega por callback: `execucao.diagnostico-concluido`,
  `billing.orcamento-aprovado|rejeitado`, `execucao.finalizada`, `billing.pagamento-aprovado|recusado`.
  A **cobrança acontece depois da execução** (decisão do time, 03/11 — ADR-0012): `execucao.finalizada`
  leva a OS a `AGUARDANDO_PAGAMENTO` e chama `POST /orcamentos/{n}/cobrar`; o link de pagamento vem na
  resposta (`billing.cobranca-criada`); `billing.pagamento-aprovado` leva a `FINALIZADA`.
- **Compensação** (recuperação para trás): `DELETE /orcamentos/{n}` (`billing.cancelar-orcamento`) e/ou
  `DELETE /execucao/ordens/{n}` (`execucao.liberar-reservas`), chamados em ordem inversa; a resposta `200`
  confirma cada compensação na hora, OS `CANCELADA` com o motivo e a saga fecha em `CANCELADA`. Toda
  compensação é idempotente nos participantes e nunca envolve estorno (nada é pago antes de executar).
  O **timeout de aprovação** (`SAGA_TIMEOUT_APROVACAO_*`) dispara a mesma compensação. Cancelar só é
  possível até a execução começar.
- **Pagamento recusado / em atraso** (após a execução) **não** compensa: a OS fica retida em
  `AGUARDANDO_PAGAMENTO`, a saga registra `pagamento-pendente` e `oficina_os_sagas_paradas` alerta;
  `POST /admin/sagas/:numero/reprocessar` chama de novo `POST /orcamentos/{n}/cobrar` (nova cobrança).
- **Falha de plataforma nunca compensa:** se uma chamada esgota as 3 tentativas (5xx/timeout/rede), a saga
  **fica no passo** (métrica `oficina_os_saga_passos_total{resultado="comando-falhou"}`), o alerta de saga
  parada acusa e `POST /admin/sagas/:numero/reprocessar` (ADMIN) reenvia o comando — idempotente pelo
  `numeroOS` no participante. Quem envia callbacks também repete 3x; `409` do OS significa "releia e repita".
- Notificação continua **in-process** (`OsStatusAlteradoEvent`, `OrcamentoProntoEvent`, `OsFinalizadaEvent`).
- **Consistência:** cada evento roda numa única transação (OS + saga no mesmo Postgres); os comandos
  HTTP saem só depois do commit; conflito de versão é refeito em processo e, se persistir, devolve 409.
- Métricas: `oficina_os_saga_passos_total`, `oficina_os_saga_passo_duracao_seconds`, `oficina_os_sagas`,
  `oficina_os_sagas_paradas` (alerta de saga travada, `SAGA_ALERTA_PARADA_MIN`),
  `oficina_integracoes_total{integracao="execucao-service"|"billing-service"}`.
- **Demo de falha:** com `SAGA_SIMULAR_FALHA_HABILITADO=true`, o header `x-simular-falha=<passo>` no
  `POST /ordens-servico` faz a saga tratar o sucesso daquele passo como falha e compensar.

---

## Observabilidade (Fase 3 — US-F3-10)

A aplicação é instrumentada de forma **agnóstica de fornecedor** (ADR-0004):

| Sinal | Onde |
|---|---|
| **Latência por rota** (p50/p95/p99) | `oficina_http_request_duration_seconds` em `GET /metrics` |
| **CPU/memória/event loop do processo** | métricas padrão do `prom-client` (prefixo `oficina_`) |
| **Volume de OS por transição de status** | `oficina_os_transicoes_total{de,para}` |
| **Erros de integração** (notificação/webhook) | `oficina_integracoes_total{integracao,resultado}` |
| **Traces (APM)** correlacionados aos logs | `dd-trace` com `logInjection`, ativado por `DD_TRACE_ENABLED=true` |
| **Correlação de requisições** | header `x-correlation-id` (US-F3-09) |

```bash
curl -s localhost:3000/metrics | grep oficina_http_request_duration_seconds_count
```

O `/metrics` é `@Public()` porque quem faz scrape é o **agente dentro do
cluster**; como não está na lista de rotas públicas do API Gateway, continua
inalcançável pela internet. O tracing é **opcional**: sem `DD_TRACE_ENABLED` a
dependência do APM nem é carregada — a app roda igual em dev e no CI.

Coletores (agente Datadog, alternativa Prometheus/Grafana e monitores de
uptime) ficam em
[soat-fiap-oficina-infra-k8s/observability](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-k8s/tree/main/observability).

## CI/CD na AWS (Fase 3 — US-F3-08)

O [`ci-cd.yml`](.github/workflows/ci-cd.yml) da Fase 2 segue como **CI**
(testes com gate de 80% + build + prova de deploy em kind efêmero). O
[`cd-aws.yml`](.github/workflows/cd-aws.yml) faz o **deploy automático na
nuvem**: push em `homolog` → homologação, push em `main` → produção.

Etapas: build da imagem → **scan Trivy** (bloqueia CRITICAL) → push no **ECR**
(tag por commit + alias do ambiente) → sincroniza os Secrets do **Secrets
Manager** → `kustomize set image` + `kubectl apply -k` [`k8s-aws/`](k8s-aws/README.md)
no **EKS** → job de migrations → `rollout status` → smoke test
(`/health` + `/health/ready`). Cada etapa é guardada: sem credenciais o run
avisa e não falha; sem `EKS_CLUSTER_NAME` para no push do ECR (a chave liga na
US-F3-06).

**Secrets** (por ambiente): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN` (AWS Academy — renovar por sessão do lab) ou `AWS_ROLE_ARN`
(OIDC em conta própria).
**Vars**: `AWS_REGION` (default `us-east-1`), `ECR_REPOSITORY` (default
`oficina-mecanica-app`), `DB_SECRET_ID` e `JWT_SECRET_ID` (Secrets Manager),
`GATEWAY_URL` (output `api_base_url` do gateway), `EKS_CLUSTER_NAME` (output do repo
[soat-fiap-oficina-infra-k8s](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-k8s)).

**Vars adicionais do overlay `k8s-aws`:** `DB_SSL=true` (RDS exige TLS) e
`JWT_ISSUER` já vêm do ConfigMap; `GATEWAY_URL` é gravada pelo script de deploy.

**Deploy ativo (desde 15/09/2026, EKS 1.36):** `https://3jpje9so5m.execute-api.us-east-1.amazonaws.com`

| O que | Como |
|---|---|
| Saúde | `curl https://3jpje9so5m.execute-api.us-east-1.amazonaws.com/health` · `https://3jpje9so5m.execute-api.us-east-1.amazonaws.com/health/ready` |
| Autenticar (cliente, só CPF) | `curl -X POST https://3jpje9so5m.execute-api.us-east-1.amazonaws.com/auth -H 'content-type: application/json' -d '{"cpf":"390.533.447-05"}'` |
| Autenticar (staff, CPF + senha) | `-d '{"cpf":"529.982.247-25","senha":"admin123"}'` (ADMIN) · mecânico `168.995.350-09`/`mecanico123` · atendente `248.301.457-73`/`atendente123` |
| Consumir APIs protegidas | `curl https://3jpje9so5m.execute-api.us-east-1.amazonaws.com/clientes -H "Authorization: Bearer <accessToken>"` — sem token o gateway devolve 401; CPF inválido 422; cliente em rota de staff 403 |
| Status público de uma OS | `GET https://3jpje9so5m.execute-api.us-east-1.amazonaws.com/ordens-servico/numero/<numero>/status` (sem token) |
| Dashboards (Datadog, org "Oficina Mecanica ORG") | [Operação (negócio)](https://app.datadoghq.com/dashboard/h6d-7ck-wpt/oficina--operacao-negocio) · [Saúde técnica](https://app.datadoghq.com/dashboard/n6g-am5-bat/oficina--saude-tecnica) — acesso mediante convite; evidências em `docs/qa-plans/evidencias/` |

O ambiente é **efêmero** ([ADR-0008](docs/arquitetura/adr/ADR-0008-ambiente-efemero.md)): se a URL acima não
responder, `scripts/aws-deploy-all.sh` do repo infra-k8s recria tudo em ~30 min e imprime a nova URL.
Conta própria + OIDC: [ADR-0007](docs/arquitetura/adr/ADR-0007-conta-aws-propria-oidc.md).

## Documentação

- **Hub de documentação (índice completo):** [`docs/README.md`](docs/README.md)
- **Swagger:** `http://localhost:3000/api` (quando a app está rodando)
- **RFCs (decisões técnicas — nuvem, banco, autenticação):** [`docs/arquitetura/rfcs/`](docs/arquitetura/rfcs/README.md)
- **ADRs (decisões arquiteturais permanentes):** [`docs/arquitetura/adr/`](docs/arquitetura/adr/README.md)
- **Banco de dados (justificativa PostgreSQL/RDS, ER, relacionamentos, índices):** [`docs/arquitetura/banco-de-dados.md`](docs/arquitetura/banco-de-dados.md)
- **ER Diagram:** `docs/schema.dbml` (importe em [dbdiagram.io](https://dbdiagram.io))
- **User Stories:** [`docs/user-stories/`](docs/user-stories/README.md)
- **QA Plans:** [`docs/qa-plans/`](docs/qa-plans/README.md)
- **Event Storming:** [Miro board (público)](https://miro.com/app/board/uXjVGwyI88w=/?share_link_id=464407873082)
