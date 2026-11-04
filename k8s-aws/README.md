# Deploy na AWS — EKS (US-F3-06)

Overlay Kustomize que leva a **mesma base** dos manifestos da Fase 2
([`k8s/`](../k8s)) para o **Amazon EKS**, com RDS, ECR e API Gateway.

```bash
kubectl apply -k k8s/        # kind / local (Fase 2) — inalterado
kubectl apply -k k8s-aws/    # EKS (Fase 3)
```

> Por que um diretório irmão e não `k8s/overlays/aws`? O Kustomize acusa
> ciclo quando o overlay vive dentro da raiz da base. Manter a base intacta
> preserva todo o fluxo local/CI da Fase 2.

## O que o overlay muda

| Ajuste | Por quê |
|---|---|
| Service `oficina-app` → **NodePort 30080** | Único caminho público é o API Gateway (VPC Link → NLB interno **único**, um target group por serviço), conforme [ADR-0005](../docs/arquitetura/adr/ADR-0005-api-gateway.md) e [ADR-0013](../docs/arquitetura/adr/ADR-0013-gateway-multi-servico.md) (Fase 4, US-F4-06) |
| `PUBLIC_BASE_URL` / `WEB_ORIGINS` → **URL do gateway** | Links de aprovação por e-mail precisam de endereço público alcançável |
| `JWT_ISSUER: oficina-auth-lambda` | A app valida tokens da Lambda (resource server — US-F3-03) |
| `replicas: 2`, `maxUnavailable: 0`, `maxSurge: 1` | Rollout sem downtime |
| `topologySpreadConstraints` por zona | Réplicas distribuídas nas 2 AZs do node group |
| **PodDisruptionBudget** `minAvailable: 1` | Mantém capacidade durante drain/upgrade de node |
| `imagePullPolicy: Always` | Tag por commit vinda do ECR |
| SPAs `web/admin` e `web/cliente` **removidas** | Elas consomem o gateway e não teriam rota pública própria; subi-las no EKS seria peso morto no node group |

HPA (2–10 réplicas, CPU 70% / memória 80%) e probes vêm da base — o
`metrics-server` é add-on do cluster ([US-F3-05](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-k8s/tree/main/cluster)).

### NodePort atrás do NLB único (Fase 4)

Na Fase 3 o Service era `LoadBalancer` (NLB próprio via provider in-tree —
Ingress/ALB exigiria IRSA, impossível no AWS Academy). Com três serviços, um
NLB por serviço seria custo e drift; o stage `gateway/` do infra-k8s cria **um
NLB interno** e um target group/listener por serviço apontando para o
**NodePort fixo** de cada um (OS `30080`, Billing `30081`, Execução `30082`).
O contrato com o gateway continua sendo um listener de LB interno — só que
gerenciado pelo Terraform, não pelo cluster.

## Pré-requisitos (outputs de outros repos)

| Recurso | Origem |
|---|---|
| Cluster EKS + VPC | [soat-fiap-oficina-infra-k8s/cluster](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-k8s/tree/main/cluster) |
| Secret do RDS (`DB_SECRET_ID`) | [soat-fiap-oficina-infra-db](https://github.com/guilhermeqmaia/soat-fiap-oficina-infra-db) |
| Segredo do JWT (`JWT_SECRET_ID`) | Secrets Manager — **o mesmo** usado pela [Lambda](https://github.com/guilhermeqmaia/soat-fiap-oficina-auth-lambda) |
| `GATEWAY_URL` | output `api_base_url` do stage `gateway/` |

Os Secrets `oficina-db` e `oficina-app` **não são versionados**: o CD os
sincroniza do Secrets Manager a cada deploy (contrato single-writer-per-Secret).

## Deploy

Automático pelo [`cd-aws.yml`](../.github/workflows/cd-aws.yml) — push em
`homolog` (homologação) ou `main` (produção). Manualmente:

```bash
aws eks update-kubeconfig --region us-east-1 --name <cluster>
kubectl -n oficina create secret generic oficina-db --from-literal=DATABASE_URL=... \
  --from-literal=DB_HOST=... --from-literal=DB_PORT=5432
cp k8s/secret.yaml.example k8s/secret.yaml   # preencha JWT_SECRET (o mesmo da Lambda)
sed -i '' "s|__GATEWAY_URL__|https://<api-id>.execute-api.us-east-1.amazonaws.com|g" \
  k8s-aws/patch-configmap.yaml

cd k8s-aws && kustomize edit set image oficina-mecanica-app=<conta>.dkr.ecr.us-east-1.amazonaws.com/oficina-mecanica-app:<sha>
kubectl apply -k .
kubectl -n oficina wait --for=condition=complete job/oficina-migrations --timeout=300s
kubectl -n oficina rollout status deployment/oficina-app
```

### Ligando o gateway ao backend

Nada a copiar: o stage `gateway/` já conhece o NodePort `30080` (`var.services.os`)
e aponta o target group para os nodes do node group. Deixe `backend_listener_arn`
vazio lá. O deploy publica no summary o NodePort efetivo e a saúde do target group:

```bash
kubectl -n oficina get svc oficina-app -o jsonpath='{.spec.ports[0].nodePort}'
aws elbv2 describe-target-health --target-group-arn <tg do os no output do gateway>
```

## Rollback

```bash
kubectl -n oficina rollout undo deployment/oficina-app          # volta 1 revisão
kubectl -n oficina rollout undo deployment/oficina-app --to-revision=<n>
kubectl -n oficina rollout history deployment/oficina-app
```

Como cada deploy usa **tag por commit**, também dá para reapontar a imagem:
`kustomize edit set image oficina-mecanica-app=<ecr>:<sha-anterior> && kubectl apply -k .`
Migrations do Prisma são forward-only: um rollback de código que exija reverter
schema precisa de migration compensatória.

## Deploy ativo

URL pública = **API Gateway** (output `api_base_url`).
<!-- atualizar após o primeiro apply na sessão do Learner Lab -->

## Validação

```bash
kubectl kustomize k8s-aws                     # build do overlay
kubectl apply -k k8s-aws --dry-run=server     # valida contra o API server
```
