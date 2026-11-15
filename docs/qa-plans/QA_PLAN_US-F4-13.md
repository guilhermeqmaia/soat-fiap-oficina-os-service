# QA Plan — US-F4-13: Cobertura ≥ 80 % por Serviço e Quality Gate no CI (SonarCloud)

> Story: [`f4-13-cobertura-e-sonar.md`](../user-stories/f4-13-cobertura-e-sonar.md) · Decisão: ADR-0011
> (SonarCloud). Repositórios: `soat-fiap-oficina-os-service`, `soat-fiap-oficina-billing-service`,
> `soat-fiap-oficina-execucao-service`. O lado do os-service também aparece no TS-10 do
> [`QA_PLAN_FLUXO-3.md`](QA_PLAN_FLUXO-3.md).

## Resumo

Valida que os três serviços têm `sonar-project.properties` apontando para a organização
`guilhermeqmaia` no SonarCloud, que a análise roda em PR e na `main` somando a cobertura de unit e
integração, que o quality gate exige cobertura em código novo ≥ 80 %, nenhum bug/vulnerabilidade
nova e duplicação < 3 %, que o Jest de cada serviço falha abaixo de 80 % (linhas, funções,
branches e statements), que há testes de domínio puros e testes de integração com Testcontainers
(Postgres) e DynamoDB Local, e que o README de cada serviço mostra os badges do gate e da cobertura.

**Projetos no SonarCloud** (organização `guilhermeqmaia`, chave `<org>_<repo>`):

| Serviço | `projectKey` |
|---|---|
| OS Service | `guilhermeqmaia_soat-fiap-oficina-os-service` |
| Billing Service | `guilhermeqmaia_soat-fiap-oficina-billing-service` |
| Execução Service | `guilhermeqmaia_soat-fiap-oficina-execucao-service` |

**Legenda de dependência**

| Marca | Significa |
|---|---|
| **[LOCAL]** | provado aqui, sem nuvem (Jest, Testcontainers, DynamoDB Local) |
| **[STUBS]** | não se aplica a esta story |
| **[AMBIENTE REAL]** | depende do SonarCloud (serviço externo; API pública, sem login para projetos públicos) |
| **[ADMIN]** | precisa de configuração de admin no GitHub/SonarCloud (`SONAR_TOKEN`, branch protection, quality gate) |

## Pré-requisitos

- Node 20 (Billing/Execução) e Node 20/22 (os-service), Docker rodando (Testcontainers e DynamoDB Local).
- Clone de cada serviço com `npm ci`; `npx prisma generate` no os-service e no Billing.
- `curl` e `jq` para a API pública do SonarCloud. Variáveis de conveniência:
  `SQ=https://sonarcloud.io/api` e `K=guilhermeqmaia_soat-fiap-oficina-<serviço>`.
- **[ADMIN]**: secret `SONAR_TOKEN` em cada repo (hoje presente nos três — `gh secret list -R guilhermeqmaia/<repo>`).

## Cenários de Teste

### TS-01: `sonar-project.properties` em cada repositório — [LOCAL]
- **Tipo:** Revisão (consulta `gh api`)
- **Critério:** `sonar-project.properties` em cada repo
- **Passos:**
  ```bash
  for r in os-service billing-service execucao-service; do
    echo "## $r"
    gh api repos/guilhermeqmaia/soat-fiap-oficina-$r/contents/sonar-project.properties --jq .content \
      | base64 -d | grep -E '^sonar\.(organization|projectKey|sources|tests|javascript\.lcov\.reportPaths|coverage\.exclusions)'
  done
  ```
- **Resultado esperado:** `sonar.organization=guilhermeqmaia`, `sonar.projectKey` da tabela acima, `sonar.sources=src`, `sonar.javascript.lcov.reportPaths=coverage/unit/lcov.info,coverage/integration/lcov.info` nos três; no os-service, nenhum placeholder `SONAR_ORG`/`SONAR_PROJECT_KEY` (o job falharia de propósito)
- **Observação:** o `soat-fiap-oficina-kit` também tem `sonar-project.properties` (fora do critério "por serviço")

### TS-02: Análise roda em PR e na `main` — [AMBIENTE REAL] [ADMIN]
- **Tipo:** Automatizado (GitHub Actions + API do SonarCloud)
- **Critério:** análise em PR e em `main`
- **Passos:**
  1. Conferir os jobs: os-service `🔎 SonarCloud (quality gate)` no `ci-cd.yml` (roda em `pull_request` e em push na `main`, reaproveitando o artifact `coverage-lcov` do passo 1); Billing/Execução `SonarCloud (quality gate)` no `ci.yml` (roda `npm run test:all:cov` e a análise)
  2. Análises da `main`: `curl -s "$SQ/project_analyses/search?project=$K&branch=main&ps=3" | jq '.analyses[] | {date, projectVersion}'`
  3. Análises de PR: `curl -s "$SQ/project_pull_requests/list?project=$K" | jq '.pullRequests[] | {key, branch, status}'`
- **Resultado esperado:** os três projetos com análise da `main` em 15/11/2026; os-service com PRs analisados (ex.: PR `115`, `qualityGateStatus: OK`) e decoração no PR do GitHub
- **Estado em 15/11/2026:** Billing e Execução ainda **sem** análise de PR (`pullRequests: []`) — o job foi ligado agora; validar no próximo PR de cada repo

### TS-03: Quality gate da `main` — [AMBIENTE REAL]
- **Tipo:** Automatizado (API pública)
- **Critério:** cobertura nova ≥ 80 %, 0 bugs/vulnerabilidades novas, duplicação < 3 %
- **Passos:**
  ```bash
  for s in os-service billing-service execucao-service; do
    K=guilhermeqmaia_soat-fiap-oficina-$s
    curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=$K&branch=main" \
      | jq -c '{s: "'$s'", status: .projectStatus.status,
                conds: [.projectStatus.conditions[] | {metricKey, errorThreshold, actualValue}]}'
  done
  curl -s "https://sonarcloud.io/api/qualitygates/get_by_project?project=$K&organization=guilhermeqmaia" | jq .
  ```
- **Resultado esperado:** `status: "OK"`; gate "Sonar way" com as condições `new_coverage` (erro se < 80), `new_duplicated_lines_density` (erro se > 3), `new_reliability_rating` e `new_security_rating` (erro se pior que A = nenhum bug/vulnerabilidade nova), `new_maintainability_rating` e `new_security_hotspots_reviewed` (100 %)
- **Estado em 15/11/2026:** os-service `OK` (`new_coverage` 100,0); Execução `OK` (`new_coverage` 96,0); Billing `NONE` — só há **uma** análise da `main`, então ainda não existe período de "código novo" para comparar. Repetir depois da próxima análise da `main` do Billing

### TS-04: Cobertura geral ≥ 80 % por serviço no SonarCloud — [AMBIENTE REAL]
- **Tipo:** Automatizado (API pública)
- **Critério:** cobertura ≥ 80 % por serviço (evidência exigida)
- **Passos:**
  ```bash
  for s in os-service billing-service execucao-service; do
    curl -s "https://sonarcloud.io/api/measures/component?component=guilhermeqmaia_soat-fiap-oficina-$s&branch=main&metricKeys=coverage,bugs,vulnerabilities,duplicated_lines_density" \
      | jq -c '{s: "'$s'", m: [.component.measures[] | {(.metric): .value}] | add}'
  done
  ```
- **Resultado esperado:** `coverage` ≥ 80 nos três
- **Estado em 15/11/2026:** os-service 93,9 %, Billing 98,0 %, Execução 95,4 %; `bugs` 0 e duplicação 0,0 % nos três; os-service com 1 vulnerabilidade **antiga** (fora do código novo, não reprova o gate — triar no SonarCloud)

### TS-05: Gate reprovado bloqueia o merge — [ADMIN]
- **Tipo:** Manual
- **Critério:** quality gate bloqueante no CI
- **Passos:**
  1. os-service: abrir PR de rascunho com uma função nova **sem teste** (código novo com cobertura < 80 %)
  2. Aguardar o job `🔎 SonarCloud (quality gate)`; conferir `gh pr checks <n>`
  3. Repetir no Billing/Execução depois que `SonarCloud (quality gate)` virar check obrigatório
  4. Fechar os PRs sem mesclar
- **Resultado esperado:** os-service: o scanner roda com `-Dsonar.qualitygate.wait=true`, o gate fica "Failed" e o job **falha**; como o check é obrigatório (ver TS-02 da [US-F4-04](QA_PLAN_US-F4-04.md)), o PR fica `BLOCKED`
- **Gap conhecido (Billing/Execução):** o job usa `SonarSource/sonarqube-scan-action@v5` **sem** `sonar.qualitygate.wait=true` — o job envia a análise e termina verde mesmo com o gate reprovado. Para ser bloqueante: adicionar `args: -Dsonar.qualitygate.wait=true` (como no os-service) e então tornar o check obrigatório na branch protection

### TS-06: Sem `SONAR_TOKEN` (PR de fork) — [LOCAL] (revisão)
- **Tipo:** Revisão dos workflows
- **Critério:** comportamento sem o secret
- **Passos:** ler o passo "Conferir configuração do SonarCloud" (os-service) e os passos "Analise"/"Sem SONAR_TOKEN" (Billing/Execução)
- **Resultado esperado:** o GitHub não entrega secrets a PRs vindos de fork, então:
  - os-service: o job **falha** com `::error title=SONAR_TOKEN ausente::…` (não pula em silêncio; aceito porque o time trabalha em branches do próprio repo — ADR-0011)
  - Billing/Execução: a análise é **pulada** com `::warning::SONAR_TOKEN ausente — analise pulada (US-F4-13).` e o job fica verde
- **Observação:** com o check obrigatório e a análise pulada, um PR de fork passaria sem gate no Billing/Execução — mais um motivo para o ajuste do TS-05

### TS-07: Jest com `coverageThreshold` de 80 % em cada serviço — [LOCAL]
- **Tipo:** Automatizado
- **Critério:** `coverageThreshold` 80 % (linhas, funções, branches) em cada serviço — gate local
- **Passos:**
  1. Conferir a configuração: `grep -n -A6 coverageThreshold jest.unit.config.ts` (os-service) e `grep -n coverageThreshold jest.unit.config.js` (Billing/Execução)
  2. Em cada serviço: `npm run test:unit:cov`
  3. Provar que o limite reprova: `npx jest --config <jest.unit.config.*> --coverage --coverageThreshold='{"global":{"lines":100,"branches":100,"functions":100,"statements":100}}'`
- **Resultado esperado:** `global: { lines: 80, functions: 80, branches: 80, statements: 80 }` nos três (no os-service também no `jest.integration.config.ts`); passo 2 verde, com o resumo de cobertura acima de 80 % nos quatro eixos; passo 3 termina com código ≠ 0 e "coverage threshold … not met"
- **Referência de resultados:** os-service unit 95,16 % linhas / 88,08 % branches (11/11/2026, FLUXO 3); Billing 99,83 % linhas / 99,25 % branches (README do Billing, 09/11/2026); Execução: registrar no checklist ao executar
- **No CI:** o os-service ainda confere 80 % de linhas no passo "Check coverage gate (80%)"; Billing/Execução dependem do `coverageThreshold` no job `Lint, typecheck, testes (gate 80%) e build`

### TS-08: Testes de domínio puros, sem infraestrutura — [LOCAL]
- **Tipo:** Automatizado
- **Critério:** testes de domínio puros (entidades, máquina de estados, orquestrador) sem infraestrutura
- **Passos:**
  1. **Parar o Docker** e não definir `DATABASE_URL`
  2. os-service: `npx jest --config jest.unit.config.ts src/ordem-de-servico/domain src/ordem-de-servico/saga/domain src/ordem-de-servico/saga/application/orquestrador-saga src/shared/architecture.spec.ts`
  3. Billing: `npx jest --config jest.unit.config.js src/orcamento/domain`
  4. Execução: `npx jest --config jest.unit.config.js src/execucao/domain src/produto/domain src/servico/domain`
- **Resultado esperado:** todas as suítes verdes sem Docker nem banco (entidades, máquina de estados da OS, `status-execucao`, `estoque`, saga); `architecture.spec.ts` verde (o domínio não importa NestJS/Prisma/infra)
- **Alternativo:** um teste de domínio que precise de container → falha com erro de conexão; mover para `*.integration.spec.ts`

### TS-09: Integração com Testcontainers (Postgres) e DynamoDB Local — [LOCAL]
- **Tipo:** Automatizado
- **Critério:** testes de integração com Testcontainers (Postgres) e DynamoDB Local; cobertura de integração somada no Sonar
- **Passos:**
  1. os-service: `npm run test:integration:cov` → `coverage/integration/lcov.info`
  2. Billing: `npm run test:integration:cov` (inclui `*.e2e.spec.ts`, um Postgres por spec, `maxWorkers: 1`)
  3. Execução: `npm run test:integration:cov` (DynamoDB Local via Testcontainers em `src/test/dynamodb.container.ts`)
  4. Em cada um: `ls coverage/unit/lcov.info coverage/integration/lcov.info` depois de `npm run test:all:cov`
- **Resultado esperado:** suítes verdes com containers efêmeros (nenhum banco local pré-existente); os dois `lcov.info` gerados — são os caminhos do `sonar.javascript.lcov.reportPaths`, então o Sonar soma unit + integração por arquivo
- **Referência:** os-service 227 testes de integração (11/11/2026); Billing 26 testes de integração e contrato (README, 09/11/2026)

### TS-10: Badges do quality gate e da cobertura no README — [LOCAL]
- **Tipo:** Revisão
- **Critério:** badge do quality gate e cobertura no README (evidência exigida)
- **Passos:** `for r in os-service billing-service execucao-service; do echo "## $r"; gh api repos/guilhermeqmaia/soat-fiap-oficina-$r/readme --jq .content | base64 -d | grep -o 'metric=[a-z_]*' | sort -u; done` e abrir os badges no GitHub
- **Resultado esperado:** `metric=alert_status` e `metric=coverage` nos três, com link para `sonarcloud.io/summary/new_code?id=<projectKey>`, renderizando "Passed" e o percentual
- **Estado em 15/11/2026:** os-service e Billing OK; **Execução sem os badges do Sonar** (gap)

## Casos de Borda

- **Primeira análise de um projeto:** o gate fica `NONE` até existir uma análise anterior (período "previous_version") — é o caso do Billing em 15/11/2026; não é reprovação
- **Arquivos fora da cobertura:** `*.module.ts`, `src/main.ts`, `**/testing/**` (os-service) e `src/dynamodb/create-tables.cli.ts` (Execução) estão em `sonar.coverage.exclusions`, espelhando o `collectCoverageFrom` do Jest — os números do Jest e do Sonar devem bater aproximadamente; diferença grande = exclusões divergentes
- **Só o lcov de unit presente:** o Sonar mostra cobertura menor para os repositórios Prisma/DynamoDB (cobertos só na integração). No os-service o job falha se faltar um dos dois arquivos (`ls -l` no passo de conferência)
- **Duplicação em DTOs:** `sonar.cpd.exclusions=**/dto/**` no os-service; sem isso, decorators repetidos do Swagger podem estourar os 3 %
- **Gate de linhas no CI do os-service:** o passo "Check coverage gate (80%)" lê o `index.html` do lcov-report; se o formato do relatório mudar, o `grep` volta vazio e o passo falha — o `coverageThreshold` do Jest continua sendo o gate principal

## Rastreabilidade

| Critério de aceite | Cenários | Status em 15/11/2026 |
|---|---|---|
| `sonar-project.properties` em cada repo | TS-01 | verificado nos três |
| Análise em PR e em `main` | TS-02, TS-06 | `main` nos três; PR só no os-service até agora |
| Quality gate: cobertura nova ≥ 80 %, 0 bugs/vulns novas, duplicação < 3 % | TS-03, TS-05 | os-service e Execução `OK`; Billing `NONE` (1ª análise); bloqueio real só no os-service |
| Jest `coverageThreshold` 80 % em cada serviço | TS-07 | configurado nos três |
| Testes de domínio puros | TS-08 | a executar |
| Integração com Testcontainers (Postgres) e DynamoDB Local | TS-09 | a executar (CI verde nos três) |
| Badge do gate e da cobertura no README | TS-10 | os-service e Billing; falta na Execução |
| Cobertura ≥ 80 % por serviço (evidência) | TS-04 | 93,9 % / 98,0 % / 95,4 % |

## Checklist de Validação

- [x] TS-01 propriedades nos três repos (15/11/2026)
- [x] TS-02 análise da `main` nos três — [ ] análise de PR no Billing e na Execução
- [x] TS-03 gate `OK` no os-service e na Execução — [ ] Billing depois da 2ª análise da `main`
- [x] TS-04 cobertura geral ≥ 80 % nos três (15/11/2026)
- [ ] TS-05 PR com gate reprovado bloqueado (os-service) — [ ] `sonar.qualitygate.wait=true` + check obrigatório no Billing/Execução
- [x] TS-06 comportamento sem `SONAR_TOKEN` (revisão)
- [ ] TS-07 Jest local nos três serviços
- [ ] TS-08 domínio sem Docker
- [ ] TS-09 integração com containers
- [ ] TS-10 badges do Sonar no README da Execução
