# QA Plan — US-F4-14: BDD dos Fluxos da OS (Gherkin + Cucumber)

> Story: [`f4-14-bdd-fluxo-completo.md`](../user-stories/f4-14-bdd-fluxo-completo.md) — exigência do
> professor (03/11/2026): Gherkin (`# language: pt`) executado com Cucumber, `.feature` por serviço e
> um fluxo completo ponta a ponta. Guia do esqueleto: [`docs/bdd/README.md`](../bdd/README.md).
> O lado do os-service também está nos TS-09/TS-12/TS-13 do [`QA_PLAN_FLUXO-3.md`](QA_PLAN_FLUXO-3.md).

## Resumo

Valida que cada serviço tem `.feature` em Gherkin executados com `@cucumber/cucumber`
(`npm run test:bdd`), com os outros serviços substituídos por mocks HTTP que seguem o
[`http-interno.md`](../contratos/http-interno.md); que o hub roda um ciclo completo da OS ponta a
ponta contra o `docker-compose.fase4.yml` (caminho feliz, compensação e idempotência); que a espera
por callbacks é por polling com timeout (sem `sleep` fixo); e que os relatórios HTML do Cucumber
são publicados como artifact no CI de cada repo.

**Onde está cada `.feature`**

| Serviço | Arquivo(s) | Comando | Cenários executados |
|---|---|---|---|
| OS Service (hub) | `features/ordem-de-servico.feature` | `npm run test:bdd` | 15 (10 declarados, 3 esquemas) |
| OS Service — ponta a ponta | `features/e2e/ciclo-completo-os.feature` | `npm run e2e:up && npm run test:bdd:e2e` | 12 (11 declarados, 1 esquema) |
| Billing | `features/orcamento.feature`, `aprovacao.feature`, `cobranca.feature`, `pagamento.feature` | `npm run test:bdd` | 16 |
| Execução | `features/execucao.feature`, `diagnostico.feature`, `cancelamento.feature` (execucao-service #6) | `npm run test:bdd` | 21 cenários, 249 passos (15/11/2026) |

**Legenda de dependência**

| Marca | Significa |
|---|---|
| **[LOCAL]** | provado aqui, sem nuvem (Cucumber com Testcontainers/stubs e `docker-compose.fase4.yml`) |
| **[STUBS]** | Billing e Execução são os stubs de `e2e/stubs` (seguem o `http-interno.md` e validam contra `docs/contratos/schemas`) — repetir com as **imagens reais** (`BILLING_IMAGE`/`EXECUCAO_IMAGE`, `BDD_E2E_REAIS=1`) |
| **[AMBIENTE REAL]** | não se aplica a esta story (BDD não depende da nuvem) |
| **[ADMIN]** | precisa de configuração de admin no GitHub (BDD como check obrigatório na branch protection) |

## Pré-requisitos

- Docker rodando (Testcontainers, `docker-compose.fase4.yml`).
- os-service: **Node 22** (o Cucumber 13 não suporta Node 20), `npm ci`, `npx prisma generate`;
  portas 3000, 3001, 3002, 8025 e 1025 livres para o compose (sobrescrevíveis por `OS_PORT` etc.).
- Billing: Node 20, `npm ci`, `npx prisma generate` (Cucumber 12; Postgres via Testcontainers, Mercado Pago e OS Service mockados com `nock`).
- Execução: `main`; `npm ci`; DynamoDB Local via Testcontainers.

## Cenários de Teste

### TS-01: Cucumber configurado em cada serviço, Gherkin em português — [LOCAL]
- **Tipo:** Revisão + Automatizado (`--dry-run`)
- **Critério:** `@cucumber/cucumber` + `ts-node` nos três serviços e no hub (`npm run test:bdd`); `# language: pt`; steps em TypeScript reutilizando `mintToken`/`mintServiceToken` do kit
- **Passos:**
  1. Em cada repo: `grep '"test:bdd' package.json` e `grep -L '# language: pt' features/**/*.feature` (não deve listar nada)
  2. os-service: `cat cucumber.js` (perfis `default` e `e2e`, `requireModule: ['ts-node/register']`, `language: 'pt'`, `strict: true`)
  3. Billing: `cat cucumber.js` (`paths: ['features/**/*.feature']`, `requireModule: ['ts-node/register']`)
  4. Tokens do kit: `grep -n "mintToken\|mintServiceToken" features/support/tokens.ts` (os-service) e `src/test/app-harness.ts` (Billing, usado pelos steps)
  5. `npx cucumber-js --dry-run` em cada repo
- **Resultado esperado:** `test:bdd` presente (os-service `cucumber-js`; Billing `TS_NODE_PROJECT=tsconfig.bdd.json cucumber-js`); todos os `.feature` com `# language: pt` (`Funcionalidade`/`Cenário`/`Dado`/`Quando`/`Então`); `--dry-run` sem steps indefinidos (com `strict: true`, step faltando reprova)
- **Execução:** repetir os passos no repo da Execução (job `BDD (Gherkin + Cucumber)` no CI)

### TS-02: OS Service — fluxo da OS orquestrado pela saga (nível de serviço) — [LOCAL]
- **Tipo:** Automatizado
- **Critério:** `.feature` por fluxo — `abrir-os`, `entrega`, `rejeicao`, `cancelamento` (lado OS Service), com os outros serviços como mocks HTTP
- **Passos:** `npm run test:bdd` (perfil `default`: Nest em memória + Postgres Testcontainers + stubs HTTP da Execução/Billing)
- **Resultado esperado:** 15 cenários verdes em `features/ordem-de-servico.feature`:
  - `@caminho-feliz` — abertura → `EM_DIAGNOSTICO` → … → `FINALIZADA` → atendente entrega → `ENTREGUE`
  - `@compensacao` — cliente rejeita o orçamento → saga compensa liberando as reservas
  - `@pagamento` — pagamento recusado mantém `AGUARDANDO_PAGAMENTO`, sem rollback, cliente notificado
  - `@cancelamento` — cancelar em `EM_DIAGNOSTICO` e em `AGUARDANDO_APROVACAO` (compensações certas por passo); cancelar depois que a execução começou → recusado
  - `@falha-plataforma` — Execução fora do ar na abertura; participante com 5xx em `GERAR_ORCAMENTO`/`INICIAR_EXECUCAO`/`COBRAR` → saga parada → reprocessar
  - `@idempotencia` — callback duplicado (3 exemplos), diagnóstico duplicado, pagamento aprovado duplicado sem nova notificação
- **Relatório:** `reports/cucumber/os-service.html`
- **Divergência registrada:** o os-service reúne os fluxos que possui num único `ordem-de-servico.feature` (tags por fluxo) em vez de `abrir-os.feature`/`entrega.feature`/`rejeicao.feature`/`cancelamento.feature`. Ficam **fora** do Gherkin (cobertos no Jest — `ordem-de-servico.e2e.spec.ts`, `orquestrador-saga.service.spec.ts`): veículo já em execução → `CANCELADA` (`EXECUCAO_RECUSADA`), entregar sem pagamento → recusado e timeout de aprovação → `TIMEOUT_APROVACAO`

### TS-03: Billing — orçamento, aprovação, cobrança e pagamento — [LOCAL]
- **Tipo:** Automatizado
- **Critério:** `orcamento.feature`, `aprovacao.feature`, `cobranca.feature`, `pagamento.feature` (Billing)
- **Passos:** no repo `soat-fiap-oficina-billing-service`: `npm ci && npx prisma generate && npm run test:bdd`
- **Resultado esperado:** 16 cenários verdes (README do Billing: 16 cenários, 95 passos):
  - `orcamento.feature` (3) — gerado a partir dos itens do diagnóstico com preços congelados; solicitação duplicada devolve o existente; compensação cancela de forma idempotente
  - `aprovacao.feature` (4) — cliente aprova e o OS Service é avisado; cliente rejeita e o motivo chega ao OS; outro cliente não pode decidir; orçamento aprovado é imutável
  - `cobranca.feature` (3) — cobrança criada para orçamento aprovado; repetir não cria outra order; orçamento sem aprovação não pode ser cobrado
  - `pagamento.feature` (6) — aprovado; recusado; nova cobrança depois de recusado; pendente mantém a cobrança aberta; webhook com assinatura inválida ignorado; webhook perdido recuperado pela reconciliação
- **Relatório:** `reports/cucumber.html`
- **Observação:** a validade do orçamento (citada na story) não tem cenário próprio no Gherkin — conferir no `QA_PLAN_FLUXO-2.md` do Billing

### TS-04: Execução — diagnóstico e execução — [LOCAL] (pendente do merge)
- **Tipo:** Automatizado
- **Critério:** `diagnostico.feature` e `execucao.feature` (Execução)
- **Passos:** no repo `soat-fiap-oficina-execucao-service`, branch `main`: `npm ci && npm run test:bdd`
- **Resultado esperado:** cenários verdes cobrindo, no mínimo: mecânico registra diagnóstico com serviços e peças → reservas de estoque → callback `execucao.diagnostico-concluido` para o OS mockado; estoque insuficiente → item recusado; iniciar baixa o estoque; concluir serviços; finalizar → callback `execucao.finalizada`
- **Status em 15/11/2026:** **pendente** — PR de BDD da Execução em andamento; a branch ainda não está no remoto e a `main` não tem `features/` nem o script `test:bdd`. Registrar o número de cenários e o link do PR no checklist quando mesclar

### TS-05: Ponta a ponta no hub — ciclo completo da OS — [LOCAL] [STUBS]
- **Tipo:** Automatizado
- **Critério:** ponta a ponta no hub: cenário feliz completo verificando status em cada serviço e a linha do tempo da saga; rejeição com compensação; idempotência
- **Passos:** `npm run e2e:up && npm run test:bdd:e2e; npm run e2e:down`
- **Resultado esperado:** 12 cenários verdes em `features/e2e/ciclo-completo-os.feature`:
  - caminho feliz da abertura à entrega (abrir → diagnóstico → orçamento → aprovar → executar → finalizar → cobrar → pagar → entregar)
  - rejeição: cliente rejeita e a Execução libera as reservas
  - pagamento recusado mantém a OS aguardando pagamento e o reprocessamento gera nova cobrança
  - cancelamento em `EM_DIAGNOSTICO` e `AGUARDANDO_APROVACAO` com compensação; cancelar após o início da execução recusado
  - falha de plataforma: Billing 5xx até esgotar o retry → saga parada → reprocessar; 5xx transitório absorvido pelo retry; Execução fora do ar na abertura
  - idempotência: callback reenviado com o mesmo `id` não duplica orçamento, notificação nem e-mail; pagamento aprovado reenviado não confirma duas vezes; `POST /execucao/ordens` repetido não duplica a fila
- **Relatório:** `reports/cucumber/e2e.html`
- **Divergências registradas:** o arquivo é `features/e2e/ciclo-completo-os.feature` (não `e2e/features/ordem-de-servico-completa.feature`); o compose sobe os-service real + Postgres, **stubs** de Billing/Execução e Mailpit (sem Lambda local nem mock do Mercado Pago — os stubs fazem esse papel)

### TS-06: Ponta a ponta com as imagens reais de Billing e Execução — [LOCAL] (pendente)
- **Tipo:** Automatizado
- **Critério:** no ponta a ponta os participantes são os serviços reais
- **Passos:** `BILLING_IMAGE=<imagem do Billing> EXECUCAO_IMAGE=<imagem da Execução> npm run e2e:up && BDD_E2E_REAIS=1 npm run test:bdd:e2e; npm run e2e:down`
- **Resultado esperado:** com `BDD_E2E_REAIS=1` o perfil `e2e` pula os cenários `@stub` (que programam falhas/consultam `/__stub/*`); compensação e cancelamento passam contra os serviços reais
- **Status:** **pendente** — depende das imagens com os endpoints de domínio (Billing `feat/fluxo-2-billing` e Execução FLUXO 1); mesmo item pendente do TS-12 do FLUXO 3

### TS-07: Mocks HTTP seguem o contrato — [LOCAL] [STUBS]
- **Tipo:** Automatizado
- **Critério:** nos `.feature` por serviço os outros serviços são mocks HTTP respondendo conforme `http-interno.md`
- **Passos:**
  1. os-service: rodar `npm run test:bdd` e conferir o step "recebeu a chamada … com o JWT de serviço do OS Service" (stubs de `features/support/participantes-stub.ts`)
  2. os-service ponta a ponta: o `After` do perfil `e2e` consulta `GET /__stub/violacoes` dos stubs de `e2e/stubs`
  3. Billing: os steps usam `nock` para o OS Service (callbacks) e para o Mercado Pago
- **Resultado esperado:** requisições do OS para os stubs com JWT `SERVICO`, `x-correlation-id` e corpo válido contra `docs/contratos/schemas`; nenhuma violação registrada (o cenário reprova se houver); no Billing, os callbacks interceptados pelo `nock` chegam com o envelope do contrato

### TS-08: Espera por callbacks com polling e timeout, sem `sleep` fixo — [LOCAL]
- **Tipo:** Revisão de código
- **Critério:** espera por callbacks com polling e timeout (`GET .../saga`, `GET .../status`); nenhum `sleep` fixo
- **Passos:**
  1. os-service: ler `features/support/polling.ts` (`aguardarAte(descricao, consulta, condicao, { timeoutMs, intervaloMs })`) e `grep -rn "setTimeout" features/` 
  2. Billing: `grep -n "ate(" features/steps/billing.steps.ts`
  3. Forçar um timeout: no os-service, `BDD_TIMEOUT_MS=1 npm run test:bdd -- --tags @caminho-feliz` (padrão: `BDD_TIMEOUT_MS=10000`, `BDD_INTERVALO_MS=100`, lidos em `features/support/env.ts`)
- **Resultado esperado:** o único `setTimeout` em `features/` é o intervalo dentro de `aguardarAte`; os steps esperam por condição (`ate(() => this.callbacks.length === 1)` no Billing); no timeout o erro mostra o último valor lido (status/passo da saga)

### TS-09: BDD no CI de cada serviço, com relatório HTML como artifact — [LOCAL] + [ADMIN]
- **Tipo:** Automatizado (GitHub Actions)
- **Critério:** executado no CI de cada serviço (job `bdd`) e no hub; relatório HTML publicado como artifact e linkado no README
- **Passos:**
  1. os-service: abrir PR e conferir os jobs `🥒 BDD (Cucumber — serviço)` e `🥒 BDD ponta a ponta (docker-compose.fase4)`; baixar os artifacts: `gh run download <id> -n cucumber-os-service` e `-n cucumber-e2e`
  2. Billing: job `BDD (Gherkin + Cucumber)` e artifact `cucumber-report` (`gh run download <id> -R guilhermeqmaia/soat-fiap-oficina-billing-service -n cucumber-report`)
  3. Execução: job equivalente depois do merge do PR de BDD
  4. Branch protection: comando do TS-02 da [US-F4-04](QA_PLAN_US-F4-04.md)
  5. READMEs: os-service seção BDD (link para `features/` e `docs/bdd/README.md`); Billing tabela de testes (`npm run test:bdd`, relatório em `reports/cucumber.html`)
- **Resultado esperado:** jobs verdes; HTML no artifact (`os-service.html`, `e2e.html`; `cucumber.html` no Billing); em falha do e2e, `e2e-compose.log` junto; os dois jobs de BDD do os-service são checks obrigatórios
- **Estado em 15/11/2026:** BDD obrigatório só no os-service; no Billing o job roda mas ainda não é obrigatório; Execução sem job
- **Divergência registrada:** não há `bdd.yml` no hub disparado por `repository_dispatch` dos serviços nem nightly; o ponta a ponta roda em **todo PR** do os-service (job `bdd-e2e`, ~1,5 min local). Disparo cruzado a partir dos PRs do Billing/Execução fica como evolução

### TS-10: PDF da entrega referencia os `.feature` — [LOCAL]
- **Tipo:** Revisão
- **Critério:** o PDF da entrega referencia os `.feature`
- **Passos:** ler `docs/entrega-fase-4.md` (PR #115, branch `docs/entrega-fase-4`) — tabela de tecnologias e checklist do enunciado
- **Resultado esperado:** cita `features/e2e/ciclo-completo-os.feature` e "BDD: um `.feature` por serviço + fluxo completo ponta a ponta"; ideal: links para os `features/` do Billing e da Execução (ver [US-F4-17](QA_PLAN_US-F4-17.md))

## Casos de Borda

- **Node 20 no os-service:** `@cucumber/cucumber` 13 recusa rodar — usar Node 22 (o CI usa 22 nos jobs de BDD); o Billing usa Cucumber 12 com Node 20
- **Portas do compose ocupadas:** `npm run e2e:up` falha; usar `OS_PORT`/`BILLING_PORT`/… e as `BDD_*_URL` correspondentes
- **Compose que não derruba:** sempre `npm run e2e:down` (remove volumes e órfãos); no CI o passo roda com `if: always()`
- **Step indefinido ou ambíguo:** com `strict: true` o cenário reprova (não fica "pending" verde)
- **Esquema do Cenário:** cada linha de `Exemplos` conta como um cenário no relatório (por isso 10 declarados = 15 executados no os-service)
- **Cenários `@stub` com imagens reais:** precisam ser pulados (`BDD_E2E_REAIS=1`); rodar sem a variável contra imagens reais falha nos steps de `/__stub/*`

## Rastreabilidade

| Critério de aceite | Cenários | Status em 15/11/2026 |
|---|---|---|
| Cucumber + ts-node nos três serviços e no hub; Gherkin pt; tokens do kit | TS-01 | os-service e Billing OK; Execução pendente do merge |
| Um `.feature` por fluxo (abrir-os, diagnóstico, orçamento, aprovação, execução, cobrança, pagamento, entrega, rejeição, cancelamento) | TS-02, TS-03, TS-04 | OS (15) e Billing (16) verdes; Execução pendente; divergências de nome/arquivo registradas no TS-02 |
| Ponta a ponta no hub: feliz, rejeição com compensação, idempotência | TS-05, TS-06 | 12 cenários verdes com stubs; imagens reais pendentes |
| Mocks HTTP conforme `http-interno.md`; serviços reais no ponta a ponta | TS-06, TS-07 | mocks OK; ponta a ponta real pendente |
| Polling com timeout, sem `sleep` | TS-08 | verificado no código |
| Executado no CI de cada serviço e no hub | TS-09 | os-service (2 jobs obrigatórios) e Billing (job não obrigatório); Execução pendente; sem `repository_dispatch`/nightly |
| Relatório HTML como artifact e linkado no README; PDF referencia os `.feature` | TS-09, TS-10 | artifacts OK; PDF em revisão (PR #115) |

## Checklist de Validação

- [x] TS-01 os-service e Billing — [ ] Execução
- [x] TS-02 `npm run test:bdd` no os-service — 15 cenários (11/11/2026)
- [x] TS-03 `npm run test:bdd` no Billing — 16 cenários (README do Billing, 09/11/2026)
- [x] TS-04 Execução (15/11/2026) — 21/21 cenários, local e CI
- [x] TS-05 ponta a ponta com stubs — 12 cenários (11/11/2026)
- [ ] TS-06 ponta a ponta com imagens reais
- [x] TS-07 mocks seguem o contrato (stubs validam contra `docs/contratos/schemas`)
- [x] TS-08 polling sem `sleep` (revisão)
- [x] TS-09 os-service — [ ] BDD obrigatório no Billing e na Execução
- [ ] TS-10 PDF com os `.feature` dos três serviços
