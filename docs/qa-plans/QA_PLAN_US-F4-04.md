# QA Plan — US-F4-04: Repositórios dos Serviços com CI/CD Independente

> Story: [`f4-04-repos-e-cicd-por-servico.md`](../user-stories/f4-04-repos-e-cicd-por-servico.md).
> Repositórios: `soat-fiap-oficina-os-service` (hub), `soat-fiap-oficina-billing-service`,
> `soat-fiap-oficina-execucao-service`. Sonar e BDD como checks obrigatórios do Billing/Execução
> são fechados pela [US-F4-13](QA_PLAN_US-F4-13.md) e pela [US-F4-14](QA_PLAN_US-F4-14.md).

## Resumo

Valida que cada microsserviço tem repositório próprio com `main` protegida (PR + 1 aprovação +
checks obrigatórios), CODEOWNERS e template de PR; que o `ci.yml` de Billing e Execução roda lint,
typecheck, testes com gate de 80 %, build e SonarCloud; que o `cd-aws.yml` publica a imagem num ECR
por serviço (Trivy antes do push), faz o deploy no EKS só quando `EKS_CLUSTER_NAME` existe e
publica o NodePort no summary; e que a autenticação na AWS é por OIDC (`AWS_ROLE_ARN`), sem chave
estática. A maior parte da verificação é feita com `gh api` (somente leitura).

**Legenda de dependência**

| Marca | Significa |
|---|---|
| **[LOCAL]** | provado aqui, sem nuvem (leitura dos workflows, `gh api`, testes locais) |
| **[STUBS]** | não se aplica a esta story (sem dependência de stubs de serviço) |
| **[AMBIENTE REAL]** | precisa da conta AWS (`--profile oficina`) e/ou do EKS no ar — deploy completo |
| **[ADMIN]** | precisa de permissão de admin no GitHub/AWS (branch protection, secrets, vars, trust da role) |

## Pré-requisitos

- `gh` autenticado com acesso de leitura aos três repositórios (`gh auth status`); para os
  cenários **[ADMIN]**, conta com papel `admin` (hoje: `guilhermeqmaia`).
- Variável de conveniência nos passos: `OWNER=guilhermeqmaia`.
- Para ler um arquivo de outro repo sem clonar:
  `gh api repos/$OWNER/<repo>/contents/<caminho> --jq .content | base64 -d`.
- **[AMBIENTE REAL]**: AWS CLI com o profile `oficina`, `kubectl`, e o ambiente subido com
  `scripts/aws-deploy-all.sh --profile oficina` do repo `soat-fiap-oficina-infra-k8s`.
- Node 20 + `npm ci` (+ `npx prisma generate` no Billing) para o TS-06.

## Cenários de Teste

### TS-01: Repositórios dos serviços existem e nasceram do scaffold do kit — [LOCAL]
- **Tipo:** Automatizado (consulta `gh`)
- **Critério:** Repos criados a partir do template do kit (PR #1 em cada, 20/10); os-service evolui para OS Service
- **Passos:**
  1. `for r in billing-service execucao-service; do gh repo view $OWNER/soat-fiap-oficina-$r --json name,visibility,defaultBranchRef --jq '"\(.name) \(.visibility) \(.defaultBranchRef.name)"'; done`
  2. `for r in billing-service execucao-service; do gh pr view 1 -R $OWNER/soat-fiap-oficina-$r --json title,state,mergedAt; done`
  3. `gh repo view $OWNER/soat-fiap-oficina-os-service --json name,description` (repo renomeado na US-F4-06)
- **Resultado esperado:** os dois repos `PUBLIC`, branch padrão `main`; PR #1 `MERGED` em 20/10/2026 com título "feat: scaffold do … a partir do template do kit (US-F4-04)"; `soat-fiap-oficina-os-service` existe (antigo `mecanica-app`)
- **Observação:** os repos foram gerados pelo template do `soat-fiap-oficina-kit` via scaffold commitado no PR #1, não pelo botão "Use this template" do GitHub — por isso `template_repository` vem `null` na API; a prova é o PR #1

### TS-02: Branch protection da `main` em cada serviço — [ADMIN]
- **Tipo:** Automatizado (consulta `gh api`)
- **Critério:** PR + 1 aprovação + checks obrigatórios; force-push e deleção bloqueados
- **Passos:**
  ```bash
  for r in os-service billing-service execucao-service; do
    echo "## $r"
    gh api repos/$OWNER/soat-fiap-oficina-$r/branches/main/protection --jq '{
      checks: .required_status_checks.contexts,
      reviews: .required_pull_request_reviews.required_approving_review_count,
      force_push: .allow_force_pushes.enabled,
      delecao: .allow_deletions.enabled,
      admins: .enforce_admins.enabled }'
  done
  ```
- **Resultado esperado (estado em 15/11/2026):**

  | Repo | `checks` obrigatórios | `reviews` | `force_push` / `delecao` |
  |---|---|---|---|
  | os-service | `1️⃣ Execução dos Testes Automatizados`, `🔎 SonarCloud (quality gate)`, `🥒 BDD (Cucumber — serviço)`, `🥒 BDD ponta a ponta (docker-compose.fase4)` | 1 | `false` / `false` |
  | billing-service | `Lint, typecheck, testes (gate 80%) e build`, `Build da imagem` | 1 | `false` / `false` |
  | execucao-service | `Lint, typecheck, testes (gate 80%) e build`, `Build da imagem` | 1 | `false` / `false` |

- **Alvo após US-F4-13/14:** Billing e Execução passam a exigir também `SonarCloud (quality gate)` e `BDD (Gherkin + Cucumber)` (nomes exatos dos jobs no `ci.yml` de cada repo). Re-executar este cenário depois da mudança e atualizar a tabela
- **Alternativo:** um check obrigatório com nome diferente do `name:` do job → o PR fica eternamente "Expected — Waiting for status to be reported"

### TS-03: PR sem aprovação ou com check vermelho não pode ser mesclado — [LOCAL]
- **Tipo:** Manual
- **Critério:** PR obrigatório + checks automáticos bloqueando o merge
- **Passos:**
  1. Num dos repos de serviço, abrir um PR de rascunho que quebra um teste unitário (ex.: inverter um `expect`)
  2. Aguardar o job `Lint, typecheck, testes (gate 80%) e build` falhar
  3. `gh pr view <n> -R $OWNER/<repo> --json mergeStateStatus,reviewDecision`
  4. Tentar `gh pr merge <n> -R $OWNER/<repo> --squash` com um usuário **sem** papel admin
  5. Fechar o PR sem mesclar e apagar a branch
- **Resultado esperado:** `mergeStateStatus` = `BLOCKED`, `reviewDecision` = `REVIEW_REQUIRED`; o merge é recusado ("base branch policy prohibits the merge")
- **Alternativo:** com admin o merge passa, porque `enforce_admins` = `false` (ver Casos de Borda)

### TS-04: CODEOWNERS, template de PR e `soat-architecture` como colaborador — [ADMIN]
- **Tipo:** Automatizado (consulta `gh api`)
- **Critério:** CODEOWNERS, template de PR, `soat-architecture` colaborador
- **Passos:**
  ```bash
  for r in os-service billing-service execucao-service; do
    R=$OWNER/soat-fiap-oficina-$r; echo "## $r"
    gh api repos/$R/contents/.github/CODEOWNERS --jq .content | base64 -d | grep -v '^#'
    gh api repos/$R/codeowners/errors --jq '.errors[].message'
    gh api repos/$R/contents/.github/pull_request_template.md --jq .name
    gh api repos/$R/collaborators --jq '.[] | "\(.login):\(.role_name)"'
    gh api repos/$R/invitations --jq '.[].invitee.login'
  done
  ```
- **Resultado esperado:** CODEOWNERS `* @guilhermeqmaia @engineercodeprojects @lucascorreiabs @GabrielCarneiroSousa`; `pull_request_template.md` presente; `soat-architecture:write` em todos; `codeowners/errors` vazio
- **Estado em 15/11/2026:** os-service sem erros. Billing e Execução retornam `Unknown owner on line 2 … @engineercodeprojects` porque o convite desse usuário ainda está **pendente** (`invitations` lista `engineercodeprojects`). Gap conhecido: aceitar o convite resolve sem mudar o arquivo

### TS-05: `ci.yml` de Billing e Execução roda lint, typecheck, testes, build e Sonar — [LOCAL]
- **Tipo:** Automatizado (leitura do workflow + execução no GitHub Actions)
- **Critério:** `ci.yml`: lint, typecheck, unit + integração com cobertura, `sonarcloud`, build da imagem
- **Passos:**
  1. `gh api repos/$OWNER/soat-fiap-oficina-billing-service/contents/.github/workflows/ci.yml --jq .content | base64 -d` (idem `execucao-service`)
  2. `gh run list -R $OWNER/soat-fiap-oficina-<repo> --workflow ci.yml --branch main --limit 1 --json databaseId,conclusion`
  3. `gh run view <id> -R $OWNER/soat-fiap-oficina-<repo> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'`
- **Resultado esperado:**
  - gatilhos `pull_request` e `push` em `main`/`homolog` + `workflow_dispatch`
  - job `Lint, typecheck, testes (gate 80%) e build`: `npm run format`, `npm run lint`, `npm run typecheck`, `npm run test:unit:cov`, `npm run test:integration`, `npm run build`, upload do `coverage/unit/lcov.info`, `npm audit --omit=dev --audit-level=high`; no Billing também "OpenAPI acompanha o codigo", "Lint do OpenAPI" e "AsyncAPI igual ao do hub" (ver [US-F4-15](QA_PLAN_US-F4-15.md))
  - job `Build da imagem` (`docker build`, depende do anterior)
  - job `SonarCloud (quality gate)` rodando `npm run test:all:cov` e a análise (ver [US-F4-13](QA_PLAN_US-F4-13.md))
  - no Billing, job `BDD (Gherkin + Cucumber)`
  - último run da `main` com todos os jobs `success`
- **Observação:** no os-service o equivalente é o `ci-cd.yml` (passos 1–4, Sonar, BDD e BDD e2e — ver [`QA_PLAN_FLUXO-3.md`](QA_PLAN_FLUXO-3.md))

### TS-06: Gate de cobertura de 80 % quebra o CI — [LOCAL]
- **Tipo:** Automatizado (local)
- **Critério:** testes com gate de 80 % (check `Lint, typecheck, testes (gate 80%) e build`)
- **Passos:** num clone do Billing ou da Execução:
  1. `npm ci` (+ `npx prisma generate` no Billing) e `npm run test:unit:cov`
  2. Simular a regressão elevando o limite só nesta execução: `npx jest --config jest.unit.config.js --coverage --coverageThreshold='{"global":{"lines":100,"branches":100,"functions":100,"statements":100}}'`
- **Resultado esperado:** passo 1 verde (o `coverageThreshold` de `jest.unit.config.js` é 80 % em linhas, funções, branches e statements); passo 2 termina com código ≠ 0 e "Jest: \"global\" coverage threshold for … not met" — é o mesmo comportamento que reprova o job no CI quando a cobertura cai abaixo de 80 %

### TS-07: CD por ambiente, ECR por serviço e Trivy antes do push — [AMBIENTE REAL]
- **Tipo:** Automatizado (GitHub Actions) + consulta AWS
- **Critério:** `cd-aws.yml`: `homolog` → homologação, `main` → produção; ECR por serviço; Trivy bloqueia CRITICAL antes do push
- **Passos:**
  1. Ler `cd-aws.yml` dos dois repos (comando do TS-05) e conferir o job `resolve` e o `env.ECR_REPOSITORY`
  2. `gh run list -R $OWNER/soat-fiap-oficina-execucao-service --workflow cd-aws.yml --branch main --limit 1 --json databaseId,conclusion`
  3. `gh run view <id> -R … --json jobs --jq '.jobs[].steps[] | "\(.name): \(.conclusion)"'`
  4. `aws ecr describe-images --repository-name oficina-execucao-service --profile oficina --query 'imageDetails[].imageTags' --output text` (idem `oficina-billing-service`)
- **Resultado esperado:** `main` → environment `production`, tag `prod`; `homolog` → `homolog`, tag `homolog`; ECR `oficina-billing-service` e `oficina-execucao-service` (var `ECR_REPOSITORY` em cada repo); ordem dos passos: `Build da imagem` → `Scan de vulnerabilidades (Trivy — bloqueia CRITICAL)` → `Push no ECR`; no ECR, tags `<sha do commit>` e `prod`
- **Evidência já coletada:** run `43709755894` da Execução (15/11/2026), `success`, com Trivy e push no ECR concluídos
- **Alternativo:** imagem com CVE CRITICAL corrigível → Trivy sai com `--exit-code 1`, push **não** acontece

### TS-08: Sem `EKS_CLUSTER_NAME` o CD para depois do push no ECR, com aviso — [LOCAL] (leitura de runs)
- **Tipo:** Automatizado (consulta de runs)
- **Critério:** até o cluster existir o CD para após o push no ECR, com aviso
- **Passos:**
  1. `gh variable list -R $OWNER/soat-fiap-oficina-execucao-service` (idem Billing)
  2. `gh run view 43709755894 -R $OWNER/soat-fiap-oficina-execucao-service --json jobs --jq '.jobs[].steps[] | "\(.name): \(.conclusion)"'`
  3. `gh run view 43709755894 -R … --log | grep 'EKS_CLUSTER_NAME ausente'`
- **Resultado esperado:** Billing e Execução sem `EKS_CLUSTER_NAME` (vars: `AWS_REGION`, `ECR_REPOSITORY`, `JWT_SECRET_ID`); no run, push no ECR `success` e `kubeconfig do EKS`, `Instalar kustomize`, `Sincronizar Secrets`, `Deploy (kustomize)`, `Smoke test`, `Publicar NodePort` como `skipped`; anotação `::notice::EKS_CLUSTER_NAME ausente — para no push do ECR.`; run termina `success`

### TS-09: Deploy completo no EKS (kustomize, migrations, rollout, smoke e NodePort) — [AMBIENTE REAL] [ADMIN]
- **Tipo:** Manual (sessão de demo na AWS)
- **Critério:** kustomize overlay `k8s-aws/`; job de migrations (Postgres); rollout + smoke `/health`; summary com Service e NodePort
- **Passos:**
  1. Subir o ambiente: `caffeinate -i scripts/aws-deploy-all.sh --profile oficina` (repo infra-k8s)
  2. Definir as vars que ligam o deploy: `gh variable set EKS_CLUSTER_NAME -R $OWNER/soat-fiap-oficina-<repo> --body <nome do cluster>`; no Billing também `DB_SECRET_ID` e `MP_SECRET_ID` (o passo "Sincronizar Secrets" falha com `::error::` sem elas)
  3. `gh workflow run cd-aws.yml -R $OWNER/soat-fiap-oficina-<repo> --ref main` e `gh run watch -R … <id>`
  4. `kubectl -n oficina get deploy oficina-billing-service oficina-execucao-service`, `kubectl -n oficina get job oficina-billing-service-migrations` e `kubectl -n oficina get svc oficina-billing-service oficina-execucao-service -o wide`
  5. Abrir o summary do run no GitHub
- **Resultado esperado:** Billing: `job/oficina-billing-service-migrations` `Complete`, `rollout status deployment/oficina-billing-service` concluído, smoke `curl -fsS http://oficina-billing-service:3001/health` e `/health/ready` OK; Execução: sem job de migrations (DynamoDB), rollout de `deployment/oficina-execucao-service` e smoke na porta `3002`; summary com "Backend interno (target group do NLB no stage gateway/)" e `Service: … · NodePort: …`
- **Status:** **pendente** — depende da sessão na AWS (mesma da demo da [US-F4-17](QA_PLAN_US-F4-17.md))

### TS-10: Sem credenciais AWS o CD avisa e não falha — [LOCAL]
- **Tipo:** Revisão do workflow (+ manual opcional num fork)
- **Critério:** guardas do CD (portabilidade entre contas)
- **Passos:** ler o passo `Ha credenciais AWS configuradas?` do `cd-aws.yml`; opcional: num fork sem secrets, `gh workflow run cd-aws.yml --ref main`
- **Resultado esperado:** sem `AWS_ROLE_ARN` nem `AWS_ACCESS_KEY_ID` → `configured=false`, `::warning::Deploy AWS IGNORADO — configure os secrets (README secao CI/CD).`, todos os passos seguintes `skipped`, run `success`

### TS-11: OIDC — role `github-actions-oficina` sem chave estática — [ADMIN] [AMBIENTE REAL]
- **Tipo:** Automatizado (consulta) + revisão
- **Critério:** Secrets/vars por repo via OIDC (`AWS_ROLE_ARN`); trust estendida aos novos repos (12 `sub`s); `aws-account-bootstrap.sh` em sincronia; vars `AWS_REGION`, `JWT_SECRET_ID`, `ECR_REPOSITORY`
- **Passos:**
  1. `for r in os-service billing-service execucao-service; do echo "## $r"; gh secret list -R $OWNER/soat-fiap-oficina-$r; gh variable list -R $OWNER/soat-fiap-oficina-$r; done`
  2. `aws iam get-role --role-name github-actions-oficina --profile oficina --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringLike' --output json`
  3. Comparar com a lista `REPOS=` de `scripts/aws-account-bootstrap.sh` do infra-k8s (`gh api repos/$OWNER/soat-fiap-oficina-infra-k8s/contents/scripts/aws-account-bootstrap.sh --jq .content | base64 -d | grep REPOS=`)
  4. No log de um run do CD, passo `Credenciais AWS`: conferir que rodou o sub-passo "OIDC (role assumida)" e não "Chaves de acesso"
- **Resultado esperado:** os três repos com o secret `AWS_ROLE_ARN` e **sem** `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`; Billing e Execução com vars `AWS_REGION`, `JWT_SECRET_ID`, `ECR_REPOSITORY`; trust com 12 `sub`s = 6 repos (os-service, infra-k8s, infra-db, auth-lambda, billing-service, execucao-service) × 2 formatos (`repo:owner/repo:*` e `repo:owner@ID/repo@ID:*`), iguais à lista do script
- **Alternativo:** repo fora da trust → "Not authorized to perform sts:AssumeRoleWithWebIdentity" no passo `Credenciais AWS`

### TS-12: Badges de CI e CD no README de cada repo — [LOCAL]
- **Tipo:** Revisão
- **Critério:** README de cada repo com badges CI e CD
- **Passos:** `for r in os-service billing-service execucao-service; do echo "## $r"; gh api repos/$OWNER/soat-fiap-oficina-$r/readme --jq .content | base64 -d | grep -o 'actions/workflows/[a-z-]*\.yml/badge.svg' | sort -u; done`
- **Resultado esperado:** os-service: `ci-cd.yml`, `cd-aws.yml` (+ `perf-nightly.yml`); Billing: `ci.yml`, `cd-aws.yml`; Execução: `ci.yml`, `cd-aws.yml`
- **Estado em 15/11/2026:** o README da Execução tem só o badge do `ci.yml` — **gap**: falta o badge do `cd-aws.yml` (e os do Sonar, ver US-F4-13)

## Casos de Borda

- **`enforce_admins` = `false` nos três repos:** um admin consegue mesclar sem aprovação/checks. Aceito para destravar o time; não usar na demo. Para a branch protection valer para todos: `gh api -X POST repos/$OWNER/<repo>/branches/main/protection/enforce_admins`
- **`require_code_owner_reviews` = `false`:** CODEOWNERS só **sugere** revisores; a aprovação exigida é de qualquer pessoa com write
- **`EKS_CLUSTER_NAME` definido com o cluster destruído:** o CD **falha** em `kubeconfig do EKS` ("No cluster found for name: …") — visto no run `43709586953` do os-service em 15/11/2026 (`oficina-mecanica-eks` destruído por custo). Depois do `aws-destroy-all.sh`, remover a var (`gh variable delete EKS_CLUSTER_NAME -R …`) ou aceitar o CD vermelho até a próxima sessão
- **Push só de documentação** (`docs/**`, `**.md`): o `cd-aws.yml` não dispara (`paths-ignore`), o `ci.yml` dispara
- **Dois pushes seguidos na mesma branch:** `concurrency: deploy-aws-<branch>` com `cancel-in-progress: false` → o segundo espera o primeiro (nunca dois rollouts simultâneos)
- **Billing sem `MP_SECRET_ID`/`DB_SECRET_ID` mas com `EKS_CLUSTER_NAME`:** o passo "Sincronizar Secrets" falha com `::error::` explícito (o serviço não sobe em produção sem as credenciais do Mercado Pago)
- **`role-session-name` copiado do template:** a composite action `aws-credentials` dos dois serviços usa `gha-oficina-os-service` como nome de sessão — não afeta a autorização, só o CloudTrail (ajuste cosmético)

## Rastreabilidade

| Critério de aceite | Cenários | Status em 15/11/2026 |
|---|---|---|
| Repos criados a partir do template do kit; os-service evolui | TS-01 | verificado |
| Branch protection (PR + 1 aprovação + checks obrigatórios) | TS-02, TS-03 | verificado (TS-02); Sonar/BDD como obrigatórios no Billing/Execução pendentes (US-F4-13/14) |
| CODEOWNERS, template de PR, `soat-architecture` colaborador | TS-04 | verificado, com gap do convite pendente de `engineercodeprojects` |
| `ci.yml`: lint, typecheck, unit + integração, sonarcloud, build | TS-05, TS-06 | verificado |
| Trivy no CD antes do push no ECR | TS-07 | verificado (run `43709755894`) |
| `cd-aws.yml`: homolog/main, ECR por serviço, overlay `k8s-aws/`, migrations, rollout + smoke | TS-07, TS-09 | ECR verificado; deploy no EKS pendente da sessão AWS |
| Para após o push no ECR enquanto não há cluster | TS-08, TS-10 | verificado |
| Summary com Service e NodePort | TS-09 | pendente da sessão AWS |
| OIDC (`AWS_ROLE_ARN`), trust com 12 `sub`s, bootstrap em sincronia, vars | TS-11 | secrets/vars verificados; trust da role a conferir com o profile `oficina` |
| Badges CI e CD no README | TS-12 | os-service e Billing OK; Execução sem badge de CD |

## Checklist de Validação

- [x] TS-01 repos e PR #1 (15/11/2026)
- [x] TS-02 branch protection — estado atual registrado (15/11/2026)
- [ ] TS-02 de novo depois de Sonar/BDD virarem obrigatórios no Billing/Execução
- [ ] TS-03 PR bloqueado (manual)
- [x] TS-04 CODEOWNERS/template/colaborador — [ ] aceitar convite de `engineercodeprojects` no Billing e na Execução
- [x] TS-05 `ci.yml` dos dois serviços (runs da `main` verdes em 15/11/2026)
- [ ] TS-06 gate de cobertura (local)
- [x] TS-07 ECR + Trivy (run `43709755894`)
- [x] TS-08 parada sem `EKS_CLUSTER_NAME`
- [ ] TS-09 deploy completo no EKS (sessão AWS)
- [x] TS-10 guarda sem credenciais (revisão)
- [ ] TS-11 trust policy da role (precisa do profile `oficina`)
- [ ] TS-12 badge de CD no README da Execução
