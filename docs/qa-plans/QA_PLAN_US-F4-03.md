# QA Plan — US-F4-03: Bancos por Servico — Postgres (OS, Billing) e DynamoDB (Execucao)

## Resumo
Valida no repo `soat-fiap-oficina-infra-db`: secret e credenciais exclusivas por servico na mesma instancia RDS, bootstrap dos bancos/usuarios via Job no EKS com isolamento por `REVOKE CONNECT`, e as 4 tabelas DynamoDB do Execucao Service (`oficina-*`, uma por agregado desde 09/11) com policy IAM e SSM.

## Pre-requisitos
- Terraform >= 1.9; profile `oficina`; para apply real: VPC/subnets do stage cluster (vars `VPC_ID`, `DB_SUBNET_IDS`, `DB_ALLOWED_CIDRS`)
- Para o bootstrap (TS-03/04): cluster no ar e `kubectl` configurado

## Cenarios de Teste

### TS-01: fmt + validate
- **Tipo:** Automatizado
- **Criterio:** Recursos Terraform validos
- **Passos:** `terraform fmt -check && terraform init -backend=false && terraform validate`
- **Resultado esperado:** valido (CI do PR verde)

### TS-02: Secrets por servico com o contrato DATABASE_URL
- **Tipo:** Manual (apos apply)
- **Criterio:** `DATABASE_URL` de cada servico em segredo proprio
- **Passos:** `aws secretsmanager get-secret-value --secret-id oficina-mecanica-prod/billing/database --query SecretString --output text | jq`
- **Resultado esperado:** chaves `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME=oficina_billing`, `DB_USER=billing`, `DB_PASSWORD`; o OS Service continua em `oficina-mecanica-prod/database`

### TS-03: Bootstrap cria banco e usuario (idempotente)
- **Tipo:** Manual
- **Criterio:** Bancos com usuarios exclusivos
- **Passos:** `scripts/db-bootstrap.sh --env prod` duas vezes
- **Resultado esperado:** 1a execucao cria role/database; 2a execucao nao falha (CREATE condicionais, ALTER ROLE PASSWORD reaplicado); logs do Job `oficina-db-bootstrap`

### TS-04: Teste negativo — credencial do Billing nao le o banco do OS
- **Tipo:** Manual
- **Criterio:** Nenhum servico acessa o banco de outro
- **Passos:** de um pod no EKS (`kubectl run psql --image=postgres:16-alpine ...`): `psql "postgresql://billing:<senha>@<host>:5432/oficina_mecanica" -c 'select 1'`
- **Resultado esperado:** `FATAL: permission denied for database "oficina_mecanica"`; com `/oficina_billing` -> `select 1` funciona

### TS-05: Tabelas DynamoDB
- **Tipo:** Manual (apos apply)
- **Criterio:** Uma tabela por agregado com prefixo `oficina-` (revisao de 09/11 da RFC-0007)
- **Passos:** `for t in execucoes servicos produtos movimentacoes_estoque; do aws dynamodb describe-table --table-name oficina-$t --query 'Table.[TableName,KeySchema,GlobalSecondaryIndexes[].IndexName,BillingModeSummary.BillingMode]'; aws dynamodb describe-continuous-backups --table-name oficina-$t; done`; `aws ssm get-parameter --name /oficina/dynamodb/execucao/table_prefix`
- **Resultado esperado:** chaves `osId` (execucoes), `servicoId` (servicos), `produtoId` (produtos), `movimentacaoId` (movimentacoes_estoque); GSIs `produtoId-data-index` e `osId-data-index` so em `movimentacoes_estoque`; PAY_PER_REQUEST; PITR ENABLED em prod; sem TTL e sem Streams; SSM com o valor `oficina-`. A antiga `oficina-execucao` sai do state sem ser destruida (apagar manualmente, ver README do infra-db)

### TS-06: Acesso do Execucao Service a tabela
- **Tipo:** Manual
- **Criterio:** Policy IAM
- **Passos:** `aws iam list-attached-role-policies --role-name oficina-mecanica-eks-node-role`
- **Resultado esperado:** `oficina-mecanica-prod-dynamodb-execucao` anexada (quando `node_role_name` informado)

### TS-07: Lambda de auth continua lendo clientes
- **Tipo:** Manual
- **Criterio:** Excecao consciente documentada (RFC-0004)
- **Passos:** `POST {gateway}/auth` com CPF de cliente apos o bootstrap
- **Resultado esperado:** 200 — a Lambda usa o banco principal (OS); nada mudou

## Casos de Borda
- `service_databases = {}` -> nenhum secret/servico criado; bootstrap avisa "nenhum secret de servico"
- `dynamodb_table_name = ""` -> sem tabela/policy/SSM
- Apply com VPC inexistente (cluster destruido) -> falha em subnet group/SG; secrets/DynamoDB podem ficar criados (free tier) — reaplicar com o cluster no ar

## Rastreabilidade
| Criterio | Cenarios |
|---|---|
| Postgres: bancos/usuarios exclusivos | TS-03, TS-04 |
| DATABASE_URL por servico no Secrets Manager | TS-02 |
| DynamoDB: 4 tabelas `oficina-*` (chaves, GSIs, PITR) | TS-05 |
| Lambda continua no banco do OS (excecao) | TS-07 |
| Teste negativo documentado | TS-04 (README) |
| Migrations por servico | template do kit (QA_PLAN_US-F4-01 TS-11) |

## Checklist de Validacao
- [x] TS-01 (20/10/2026)
- [ ] TS-02..TS-07 — proximo ciclo de deploy
