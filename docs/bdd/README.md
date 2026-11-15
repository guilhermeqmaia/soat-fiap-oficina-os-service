# BDD com Gherkin + Cucumber (US-F4-14)

Exigência do professor (03/11/2026): cenários em **Gherkin** (`# language: pt`) executados com
**Cucumber** (`@cucumber/cucumber`), um `.feature` por fluxo em cada serviço e um ponta a ponta no hub.
Este repositório (OS Service) tem o **esqueleto de referência** que o Billing e a Execução copiam.

Há dois níveis:

| Nível | Perfil | Comando | O que sobe | Onde ficam os `.feature` |
|---|---|---|---|---|
| Serviço | `default` | `npm run test:bdd` | Nest em memória + Postgres (Testcontainers) + **stubs HTTP** no lugar dos outros serviços | `features/` |
| Ponta a ponta | `e2e` | `npm run test:bdd:e2e` | nada: aponta para o `docker-compose.fase4.yml` (`npm run e2e:up`); Billing/Execução = stubs de `e2e/stubs` ou imagens reais | `features/e2e/` |

Relatórios: `reports/cucumber/os-service.html` e `.json` (perfil `e2e`: `e2e.html`/`e2e.json`).
A pasta `reports/` não vai para o git.

**No CI** (`.github/workflows/ci-cd.yml`, todo PR e `main`): job `bdd` (`npm run test:bdd`, artifact
`cucumber-os-service`) e job `bdd-e2e` (`e2e:up` → `test:bdd:e2e` → `e2e:down`, artifact `cucumber-e2e`
com o log do compose em caso de falha). Ambos com Node 22.

## Estrutura

```
cucumber.js                         # perfis default e e2e, formatters, ts-node
features/
├── tsconfig.json                   # estende o tsconfig da raiz (rootDir "..", sem tipos do jest)
├── ordem-de-servico.feature        # fluxo da OS orquestrado pela saga
├── e2e/ciclo-completo-os.feature   # perfil e2e: ciclo completo contra o docker-compose.fase4.yml
├── step-definitions/
│   ├── ordem-de-servico.steps.ts   # Dado/Quando/Então do domínio: OS, saga, callback, notificação
│   ├── participantes.steps.ts      # programar e consultar os stubs ("o serviço X responde 503 em ...")
│   └── e2e/ciclo-completo.steps.ts # só e2e: ações das pessoas, estado nos participantes, Mailpit, /metrics
└── support/
    ├── env.ts                      # variáveis de ambiente de teste (importado antes do AppModule)
    ├── contexto.ts                 # estado da execução: cliente HTTP, stubs, mecanicoId
    ├── world.ts                    # MundoOS: estado do cenário + operações de domínio (abrir, callback, ...)
    ├── http-client.ts              # fetch contra uma URL base (Nest em memória ou serviço no compose)
    ├── tokens.ts                   # mintToken / mintServiceToken do kit por ator
    ├── polling.ts                  # aguardarAte(): polling com timeout, sem sleep fixo
    ├── dados.ts                    # CPF e placa aleatórios válidos, itens padrão do diagnóstico
    ├── stub-http.ts                # stub HTTP genérico (node:http) com rotas no formato do contrato
    ├── participantes-stub.ts       # rotas da Execução e do Billing que o OS Service consome
    ├── servico/app.hooks.ts        # perfil default: sobe stubs + Postgres + Nest (BeforeAll)
    └── e2e/                        # perfil e2e: 00-env (segredo/URLs do compose), hooks (health,
                                    # mecânico, violações de contrato), participante-remoto (/__stub/*),
                                    # ambiente (ações que geram callbacks, Mailpit, parser do /metrics)
e2e/stubs/                          # stubs do Billing e da Execução usados pelo docker-compose.fase4.yml
```

### Como o nível de serviço funciona

1. `BeforeAll` sobe dois stubs HTTP (Execução e Billing) em portas livres, aponta
   `EXECUCAO_SERVICE_URL`/`BILLING_SERVICE_URL` para eles, sobe o Postgres com
   `src/test/database.container.ts` (aplica as migrations) e só então importa o `AppModule`
   e faz `app.listen(0)`. Uma única aplicação serve a execução inteira.
2. O OS Service fala com os stubs pelo **`HttpParticipantesSaga` real** (cliente HTTP do kit:
   JWT de serviço, `x-correlation-id`, 3 tentativas em 5xx). Por isso um `503` no stub gera
   3 chamadas, e o step `recebeu a chamada ... com o JWT de serviço do OS Service` confere o token.
3. Os callbacks da Execução/Billing são simulados com
   `POST /ordens-servico/{numero}/eventos` e token `mintServiceToken({ servico: 'execucao-service' | 'billing-service' })`.
4. `Before` limpa as respostas programadas e as chamadas dos stubs. Cada cenário cria o seu
   cliente e veículo (CPF e placa aleatórios), então os cenários não dependem uns dos outros.
5. Todo estado é lido **pela API** (`GET .../numero/{n}/status`, `GET .../numero/{n}/saga`,
   `GET /clientes/{cpf}/notificacoes`), com polling (`aguardarAte`), nunca direto no banco.

> **Rotas por id e por número.** As ações do atendente usam o **id** (UUID) da OS
> (`POST /ordens-servico/{id}/cancelar`, `.../{id}/entregar`). Callback, status público e saga
> usam o **número** (`OS-AAAA-...`): `POST /ordens-servico/{numero}/eventos`,
> `GET /ordens-servico/numero/{numero}/status|saga`. O `MundoOS` guarda os dois (`this.os`).

## Como rodar

Pré-requisitos: Node 22+, Docker rodando (Testcontainers), `npm ci` e `npx prisma generate`.

```bash
npm run test:bdd                                   # todos os cenários do serviço
npx cucumber-js --tags @idempotencia               # só uma tag
npx cucumber-js features/ordem-de-servico.feature:16   # um cenário pela linha
BDD_LOG=1 npm run test:bdd                         # com logs do Nest/pino (depuração)
npx cucumber-js --dry-run                          # confere se todo step tem definição, sem executar
```

Variáveis úteis: `BDD_TIMEOUT_MS` (timeout do polling, padrão 10000), `BDD_INTERVALO_MS` (100),
`BDD_LOG`. No perfil `e2e`: `BDD_OS_SERVICE_URL`, `BDD_MECANICO_ID` e o mesmo `JWT_SECRET` dos serviços.

Um cenário que falha anexa ao relatório HTML a OS, a última resposta HTTP e as chamadas recebidas pelos stubs.

## Como escrever um cenário novo

1. Escreva em português, na linguagem do domínio (OrdemDeServico, orçamento, Execução, Billing),
   com `# language: pt` na primeira linha do arquivo. Palavras-chave: `Funcionalidade`, `Contexto`,
   `Cenário`, `Esquema do Cenário` + `Exemplos`, `Dado`, `Quando`, `Então`, `E`, `Mas`.
2. **Reaproveite os steps que já existem** (`npx cucumber-js --dry-run` lista os que faltam):

   | Tipo | Step |
   |---|---|
   | Dado | `que existe um cliente com veículo` |
   | Dado | `que existe uma OS no status "AGUARDANDO_APROVACAO"` (leva a OS pelo caminho feliz) |
   | Dado | `que o serviço "Billing" responde 503 em "POST /orcamentos"` |
   | Dado | `que o serviço "Execução" está fora do ar em "POST /execucao/ordens"` |
   | Dado | `que o serviço "Execução" recusa "POST /execucao/ordens/{n}/iniciar" com o motivo "estoque insuficiente"` (409) |
   | Quando | `o atendente abre uma OS para o veículo` |
   | Quando | `o serviço "Execução" envia o callback "execucao.finalizada" para a OS` (dados padrão por `type`) |
   | Quando | `o serviço "Billing" envia o callback "billing.pagamento-recusado" para a OS com:` + tabela `campo \| valor` |
   | Quando | `o serviço "Billing" reenvia o mesmo callback` (mesmo `id` de envelope) |
   | Quando | `o atendente cancela a OS` / `o atendente entrega o veículo` / `o administrador reprocessa a saga` |
   | Quando | `o serviço "Billing" volta ao ar` |
   | Então | `a OS fica com status "EM_EXECUCAO"` (polling) / `a OS permanece com status "..."` |
   | Então | `a OS é cancelada com o motivo "ORCAMENTO_REJEITADO"` |
   | Então | `a saga fica no passo "AGUARDAR_PAGAMENTO" com status "EM_ANDAMENTO"` |
   | Então | `as compensações confirmadas da saga são "billing.cancelar-orcamento, execucao.liberar-reservas"` / `a saga não tem compensações` |
   | Então | `o histórico da saga termina com "billing.pagamento-recusado" e resultado "pagamento-pendente"` |
   | Então | `o callback é aplicado` / `o callback é reconhecido como duplicado e não é reaplicado` |
   | Então | `o serviço "Billing" recebeu 1 chamada em "POST /orcamentos/{n}/cobrar"` / `não recebeu chamadas em "..."` |
   | Então | `o cliente recebe a notificação "ORCAMENTO_PRONTO"` / `o cliente recebe 1 notificação "..."` / `o cliente não recebe a notificação "..."` |
   | Então | `a resposta tem status HTTP 400` |

   As rotas dos stubs são escritas como no `docs/contratos/http-interno.md`, com `{n}` no lugar do número da OS.
3. Use `Contexto` para o que todo cenário do arquivo precisa e `Esquema do Cenário` quando o
   mesmo roteiro vale para várias linhas (ver cancelamento, falha 5xx e idempotência no `.feature`).
4. Step novo: coloque a lógica no `MundoOS` (`world.ts`) e deixe o step fino. Nada de `sleep`:
   para esperar um efeito assíncrono, use `aguardarAte(descricao, consulta, condicao)`.
5. Notificações: hoje só existem `ORCAMENTO_PRONTO` e `OS_FINALIZADA` (além do genérico
   `STATUS_OS_ALTERADO`). Os tipos da US-F4-12 (`ORCAMENTO_APROVADO`, `PAGAMENTO_PENDENTE`,
   `PAGAMENTO_APROVADO`, `PAGAMENTO_RECUSADO`, `OS_CANCELADA`) estão marcados com comentário
   `# Próxima etapa (US-F4-12)` no `.feature`. Quando existirem, basta acrescentar
   `E o cliente recebe a notificação "..."` nesses pontos.

## Como os outros serviços copiam o esqueleto

### 1. Dependências e scripts

```bash
npm install -D @cucumber/cucumber@^13.3.0 expect@^30 ts-node
```

No `package.json`: `"test:bdd": "cucumber-js"` e `"test:bdd:e2e": "cucumber-js --profile e2e"`.
No `.gitignore`: `reports/`.

### 2. Arquivos a copiar

| Arquivo | Copiar | O que adaptar |
|---|---|---|
| `cucumber.js` | como está | nome dos relatórios (`os-service.html` → `billing-service.html` / `execucao-service.html`); remova o perfil `e2e` (ele só existe no hub) |
| `features/tsconfig.json` | como está | `exclude` se o código não estiver em `src/` |
| `features/support/env.ts` | como está | variáveis obrigatórias do **seu** `validateEnv` (ex.: `MP_ACCESS_TOKEN`, `DYNAMODB_ENDPOINT`) |
| `features/support/polling.ts` | como está | — |
| `features/support/http-client.ts` | como está | — |
| `features/support/stub-http.ts` | como está | — |
| `features/support/tokens.ts` | como está | atores que o seu serviço usa |
| `features/support/dados.ts` | o que servir | dados do seu domínio |
| `features/support/contexto.ts` | como está | troque o tipo `Participante` e `mecanicoId` pelo que o seu serviço precisa |
| `features/support/participantes-stub.ts` | **reescrever** | as rotas que o **seu** serviço consome. Billing: callback do OS Service (`POST /ordens-servico/{n}/eventos` → `200 { aplicado: true }`) e a API do Mercado Pago (`POST /v1/orders`). Execução: `POST /ordens-servico/{n}/eventos` |
| `features/support/servico/app.hooks.ts` | **adaptar** | Billing: Postgres com o mesmo `startTestDatabase()` (copie `src/test/database.container.ts`). Execução: DynamoDB Local (Testcontainers `amazon/dynamodb-local`) + criação da tabela. Aponte as URLs dos serviços externos para os stubs **antes** do `import()` do `AppModule` |
| `features/support/world.ts` | **adaptar** | mantenha a forma (estado do cenário + operações de domínio); troque as operações pelas do seu serviço (ex.: `gerarOrcamento`, `aprovarOrcamento`, `receberWebhookMP`) |
| `features/step-definitions/participantes.steps.ts` | como está | nomes dos participantes aceitos em `participante()` (ex.: `"OS Service"`, `"Mercado Pago"`) |
| `features/step-definitions/ordem-de-servico.steps.ts` | modelo | mantenha os textos que fizerem sentido (`a OS fica com status ...` vira `o orçamento fica com status ...`) |

### 3. `.feature` de cada serviço (US-F4-14)

- **Billing:** `orcamento.feature`, `aprovacao.feature`, `cobranca.feature`, `pagamento.feature`
  (o callback para o OS Service é verificado pelo stub: `o serviço "OS Service" recebeu 1 chamada em "POST /ordens-servico/{n}/eventos"`).
- **Execução:** `diagnostico.feature`, `execucao.feature` (+ a parte da Execução em `rejeicao`/`cancelamento`).
- **OS Service (este repo):** `ordem-de-servico.feature` hoje; a story também lista `abrir-os.feature`
  e `entrega.feature`, que podem ser extraídos dele quando os fluxos crescerem.

### 4. Ponta a ponta (hub)

`features/e2e/ciclo-completo-os.feature` roda com `npm run test:bdd:e2e` contra o
`docker-compose.fase4.yml` (`npm run e2e:up` / `npm run e2e:down`), só por HTTP. Reaproveita
`features/support/*.ts` e **todos** os steps de domínio e de participante:

- os callbacks saem do participante, disparados pela ação da pessoa no serviço dela
  (`POST /execucao/ordens/{n}/diagnostico`, `POST /orcamentos/{n}/aprovar`...): o `MundoOS`
  delega ao `acionadorCallbacks` do contexto (`features/support/e2e/ambiente.ts`);
- os steps de stub ("o serviço X recebeu N chamadas em ...", "está fora do ar em ...") funcionam
  contra os containers de `e2e/stubs` via `/__stub/*` (`participante-remoto.ts`);
- o `After` reprova o cenário se os stubs registraram alguma divergência de contrato.

Com as imagens reais (`BILLING_IMAGE`/`EXECUCAO_IMAGE`), `BDD_E2E_REAIS=1` pula os cenários `@stub`.
Roteiro manual equivalente, com saídas reais: [`docs/fluxo-3/teste-manual-ponta-a-ponta.md`](../fluxo-3/teste-manual-ponta-a-ponta.md).
