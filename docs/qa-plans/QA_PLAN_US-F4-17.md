# QA Plan — US-F4-17: Entrega da Fase 4 — Vídeo, PDF e Diagrama Geral

> Story: [`f4-17-entrega-video-pdf.md`](../user-stories/f4-17-entrega-video-pdf.md). Fonte do PDF:
> `docs/entrega-fase-4.md` (PR #115, branch `docs/entrega-fase-4` — **ainda não mesclado** em
> 15/11/2026; a seção 8 traz o roteiro do vídeo e a 9 o checklist operacional da demo). Espelha o
> [`QA_PLAN_US-F3-12.md`](QA_PLAN_US-F3-12.md).

## Resumo

Checklist de validação do pacote de entrega da Fase 4: **vídeo ≤ 15 min** com as quatro
demonstrações exigidas (fluxo completo de uma OS pelos três serviços; saga com falha e compensação;
deploy automatizado de um serviço com testes/quality gate; monitoramento e rastreamento), **PDF
único** com participantes, links de todos os repositórios e do vídeo, diagrama geral, estratégia de
saga com justificativa, justificativa da divisão e das tecnologias e evidências de cobertura e de
branch protection; `soat-architecture` em todos os repos; e ambiente subido → demo gravada →
ambiente destruído (custo).

**Legenda de dependência**

| Marca | Significa |
|---|---|
| **[LOCAL]** | verificável sem nuvem (revisão do documento, `gh api`, API pública do SonarCloud) |
| **[STUBS]** | ensaio do roteiro com `docker-compose.fase4.yml` (Billing/Execução como stubs) antes da sessão AWS |
| **[AMBIENTE REAL]** | precisa do ambiente AWS no ar (EKS, RDS ×2, DynamoDB, Lambda, gateway, Datadog) — sessão de gravação |
| **[ADMIN]** | precisa de admin no GitHub/AWS (colaboradores, branch protection, vars, deploy/destroy) |

## Pré-requisitos

- `docs/entrega-fase-4.md` lido da branch do PR enquanto ele não mesclar:
  `git fetch origin docs/entrega-fase-4 && git show origin/docs/entrega-fase-4:docs/entrega-fase-4.md`.
- Roteiro ensaiado com cronômetro (seção 8 do documento); ensaio opcional [STUBS] com
  `npm run e2e:up` e o roteiro [`docs/fluxo-3/teste-manual-ponta-a-ponta.md`](../fluxo-3/teste-manual-ponta-a-ponta.md).
- **[AMBIENTE REAL]**: checklist da seção 9 do documento — `caffeinate -i scripts/aws-deploy-all.sh --profile oficina`
  (repo infra-k8s, ~30 min); secret do Mercado Pago em `MP_SECRET_ID`; `EKS_CLUSTER_NAME` no Billing
  e na Execução; seeds de demonstração; webhook do Mercado Pago apontando para `{gateway}/webhooks/mercadopago`.
- Ferramenta de exportação para PDF (qualquer conversor Markdown → PDF que preserve links e imagens).

## Cenários de Teste

### TS-01: Vídeo — fluxo completo de uma OS pelos três serviços — [AMBIENTE REAL]
- **Tipo:** Manual (gravação)
- **Critério:** vídeo: fluxo completo de uma OS pelos três serviços
- **Passos** (bloco 1:30–5:30 do roteiro): atendente abre a OS pelo gateway → Execução enfileira → mecânico vincula serviços/peças e conclui o diagnóstico (estoque baixa) → Billing gera o orçamento → cliente aprova → execução → finalizar → cobrança no Mercado Pago (link do sandbox) → pagamento aprovado → `FINALIZADA` → entrega; mostrar `GET /ordens-servico/numero/{numero}/saga` em cada passo
- **Resultado esperado:** status da OS `RECEBIDA → EM_DIAGNOSTICO → AGUARDANDO_APROVACAO → EM_EXECUCAO → AGUARDANDO_PAGAMENTO → FINALIZADA → ENTREGUE` visível; a linha do tempo da saga mostra cada chamada e callback; chamadas atendidas pelos três serviços reais (não stubs)
- **Ensaio [STUBS]:** mesmo roteiro no compose da Fase 4 (BDD `@caminho-feliz` do `ciclo-completo-os.feature` prova o fluxo)

### TS-02: Vídeo — saga com falha e compensação — [AMBIENTE REAL]
- **Tipo:** Manual (gravação)
- **Critério:** execução da saga com uma falha e a compensação
- **Passos** (bloco 5:30–8:30):
  1. Orçamento rejeitado → saga `COMPENSANDO` → estoque devolvido (`GET /execucao/ordens/{n}/movimentacoes`) → OS `CANCELADA`
  2. Falha injetada com o header `x-simular-falha` → retry esgotado → alerta de saga parada → `POST /admin/sagas/{n}/reprocessar` ([runbook](../runbooks/saga-reprocessar.md)) → saga retoma
  3. Pagamento recusado → OS retida em `AGUARDANDO_PAGAMENTO`, sem rollback
- **Resultado esperado:** os três desfechos aparecem no `GET .../saga` (compensações com `confirmadaEm`; histórico `chamada-falhou` e depois a retomada; `pagamento-pendente`)

### TS-03: Vídeo — deploy automatizado com testes e quality gate — [AMBIENTE REAL] [ADMIN]
- **Tipo:** Manual (gravação)
- **Critério:** deploy automatizado de um serviço com validação de testes/quality gate
- **Passos** (bloco 8:30–11:30): PR pequeno num serviço → checks obrigatórios (testes, SonarCloud, BDD) → merge → `cd-aws.yml` → imagem no ECR → `kubectl -n oficina rollout status deployment/<serviço>` → smoke
- **Resultado esperado:** checks verdes visíveis no PR antes do merge (no os-service: `1️⃣ Execução dos Testes Automatizados`, `🔎 SonarCloud (quality gate)` e os dois de BDD); run do CD com Trivy, push no ECR, rollout e smoke `/health`; ver TS-07/TS-09 da [US-F4-04](QA_PLAN_US-F4-04.md)
- **Dica:** gravar com o os-service — é o único repo em que Sonar e BDD já são checks obrigatórios (15/11/2026)

### TS-04: Vídeo — monitoramento e rastreamento — [AMBIENTE REAL]
- **Tipo:** Manual (gravação)
- **Critério:** monitoramento e rastreamento (trace + dashboard + DLQ)
- **Passos** (bloco 11:30–14:30): no Datadog, trace de uma OS atravessando OS → Execução → Billing com o mesmo `x-correlation-id`; dashboard "Oficina — Fluxo distribuído"; logs correlacionados; monitor de saga parada
- **Resultado esperado:** um trace único ligando os três serviços; dashboard com as métricas da saga; monitor de saga parada (disparado no TS-02) visível
- **Observação:** a "DLQ" do critério deixou de existir com a RFC-0008 (sem SNS/SQS); o equivalente mostrado é o monitor de **saga parada** + `oficina_os_sagas_paradas` + reprocessar. Explicar isso em uma frase no vídeo e no PDF

### TS-05: Vídeo — duração ≤ 15 min e publicação — [LOCAL]
- **Tipo:** Manual
- **Critério:** vídeo (≤ 15 min) publicado
- **Passos:** publicar (YouTube não listado); abrir o link numa janela anônima; conferir duração e visibilidade; colar o link na seção 3 do documento
- **Resultado esperado:** ≤ 15:00; acessível sem login; os quatro blocos dos TS-01..TS-04 presentes (conferir pelos tempos do roteiro)

### TS-06: PDF — conteúdo obrigatório — [LOCAL]
- **Tipo:** Revisão (checklist)
- **Critério:** PDF com participantes, links dos repositórios (todos), link do vídeo, diagrama geral, estratégia de saga com justificativa, justificativa da divisão e das tecnologias, evidências de cobertura e de branch protection
- **Passos:** abrir o PDF gerado de `docs/entrega-fase-4.md` e marcar:

  | Item | Onde no documento | Conferência |
  |---|---|---|
  | Participantes | §1 | 4 integrantes com GitHub e fluxo |
  | Links de todos os repositórios | §2 | 7 repos (TS-07) |
  | Link do vídeo | §3 | preenchido (hoje ⏳) |
  | Diagrama geral | §4 | imagem `arquitetura/diagramas/fase4/01-visao-geral.png` renderizada no PDF |
  | Estratégia de saga + justificativa | §5 | tabela de passos, rollback/compensação, "Por que orquestração" |
  | Justificativa da divisão e das tecnologias | §6 | 3 serviços + tabela de tecnologias |
  | Evidência de cobertura | §2 | links do SonarCloud dos 3 serviços (TS-08) |
  | Evidência de branch protection | §2 | texto "Proteção da `main`" (TS-08) + print, se exigido |
  | URLs do ambiente | §9 | preenchidas (hoje ⏳) |

- **Resultado esperado:** todos os itens presentes; nenhum ⏳ restante no PDF final; links clicáveis

### TS-07: PDF — links dos repositórios abrem — [LOCAL]
- **Tipo:** Automatizado (consulta `gh`)
- **Critério:** links dos repositórios (todos)
- **Passos:**
  ```bash
  for r in os-service billing-service execucao-service kit infra-k8s infra-db auth-lambda; do
    gh repo view guilhermeqmaia/soat-fiap-oficina-$r --json nameWithOwner,visibility --jq '"\(.nameWithOwner) \(.visibility)"'
  done
  ```
- **Resultado esperado:** 7 repositórios encontrados, os mesmos da tabela da §2 (os-service, billing-service, execucao-service, kit, infra-k8s, infra-db, auth-lambda)

### TS-08: PDF — evidências batem com o estado real — [LOCAL] [ADMIN]
- **Tipo:** Automatizado (API) + revisão
- **Critério:** evidências de cobertura e de branch protection
- **Passos:**
  1. Cobertura e gate: comandos dos TS-03/TS-04 da [US-F4-13](QA_PLAN_US-F4-13.md)
  2. Branch protection: comando do TS-02 da [US-F4-04](QA_PLAN_US-F4-04.md)
  3. Comparar com o parágrafo "Proteção da `main`" da §2
- **Resultado esperado:** cobertura ≥ 80 % e gate `OK` nos três; o texto do PDF descreve exatamente os checks obrigatórios de cada repo
- **Divergência em 15/11/2026:** o documento afirma que no Billing e na Execução os checks obrigatórios incluem "SonarCloud e BDD", mas a branch protection desses repos exige só `Lint, typecheck, testes (gate 80%) e build` e `Build da imagem`. Antes de gerar o PDF: tornar os checks obrigatórios (US-F4-13/14) **ou** ajustar o texto. Billing com gate `NONE` (1ª análise) e Execução sem badges do Sonar no README — resolver antes da entrega

### TS-09: `soat-architecture` em todos os repositórios — [ADMIN]
- **Tipo:** Automatizado (consulta `gh api`)
- **Critério:** `soat-architecture` confirmado em todos os repos
- **Passos:**
  ```bash
  for r in os-service billing-service execucao-service kit infra-k8s infra-db auth-lambda; do
    printf '%s: ' $r
    gh api repos/guilhermeqmaia/soat-fiap-oficina-$r/collaborators/soat-architecture --silent && echo OK || echo FALTA
  done
  ```
- **Resultado esperado:** `OK` nos 7 (a API responde `204` para colaborador)
- **Estado em 15/11/2026:** `soat-architecture` com papel `write` nos 7 repos

### TS-10: Ambiente subido, demo gravada, ambiente destruído — [AMBIENTE REAL] [ADMIN]
- **Tipo:** Manual
- **Critério:** ambiente subido, demo gravada, ambiente destruído (custo)
- **Passos:**
  1. Subir: itens 1–5 da §9 do documento (`aws-deploy-all.sh`, Mercado Pago, `EKS_CLUSTER_NAME`, seeds, cenários do sandbox)
  2. Antes de gravar: `curl -s $GW/health` (URL do output `api_base_url`) e os três serviços `Running` (`kubectl -n oficina get pods`)
  3. Gravar (TS-01..TS-04) e preencher as URLs ⏳ da §9
  4. Destruir: `scripts/aws-destroy-all.sh --yes` (ou `scripts/aws-pause.sh` se houver nova gravação), repo infra-k8s
  5. Limpar as vars que ligam o deploy: `gh variable delete EKS_CLUSTER_NAME -R guilhermeqmaia/<repo>` nos repos de serviço (senão o próximo CD falha em "kubeconfig do EKS" — caso de borda da US-F4-04)
  6. Conferir: `aws eks list-clusters --profile oficina` e `aws rds describe-db-instances --profile oficina --query 'DBInstances[].DBInstanceIdentifier'`
- **Resultado esperado:** health `200` durante a gravação; depois do destroy, nenhum cluster EKS nem instância RDS do projeto; CDs seguintes param no push do ECR sem falhar

## Casos de Borda

- **Vídeo passando de 15 min:** cortar o bloco de deploy para o log de um run pronto (`gh run view <id>`); manter fluxo completo e saga, que são o núcleo da Fase 4
- **URL do gateway muda a cada `aws-deploy-all.sh`:** no PDF, citar a URL usada na gravação e o comando para reproduzir
- **Webhook do Mercado Pago sem URL pública:** o pagamento fica `PENDENTE`; usar o replay assinado de `docs/mercado-pago-sandbox.md` e a reconciliação do Billing
- **PR #115 alterado depois da gravação:** regenerar o PDF a partir da versão mesclada na `main`, não da branch
- **Imagem do diagrama não renderiza no PDF:** caminho relativo (`arquitetura/diagramas/fase4/01-visao-geral.png`) depende de exportar a partir de `docs/`; conferir no PDF final
- **Ambiente esquecido no ar:** custo contínuo de EKS + 2 RDS — o passo 6 do TS-10 é obrigatório

## Rastreabilidade

| Critério de aceite | Cenários | Status em 15/11/2026 |
|---|---|---|
| Vídeo: fluxo completo de uma OS pelos três serviços | TS-01, TS-05 | pendente (sessão AWS) |
| Vídeo: saga com uma falha e a compensação | TS-02, TS-05 | pendente (sessão AWS) |
| Vídeo: deploy automatizado com testes/quality gate | TS-03, TS-05 | pendente (sessão AWS) |
| Vídeo: monitoramento e rastreamento (trace + dashboard + DLQ → saga parada) | TS-04, TS-05 | pendente (sessão AWS) |
| PDF: participantes, links (todos), vídeo, diagrama, saga, divisão/tecnologias, evidências | TS-06, TS-07, TS-08 | documento no PR #115; link do vídeo e URLs ⏳; texto de branch protection divergente |
| `soat-architecture` em todos os repos | TS-09 | verificado nos 7 |
| Ambiente subido, demo gravada, ambiente destruído | TS-10 | pendente |

## Checklist de Validação

- [ ] TS-01 fluxo completo gravado
- [ ] TS-02 saga com falha e compensação gravada
- [ ] TS-03 deploy automatizado gravado
- [ ] TS-04 monitoramento/rastreamento gravado
- [ ] TS-05 vídeo ≤ 15 min publicado e acessível
- [ ] TS-06 PDF com todos os itens, sem ⏳
- [x] TS-07 7 repositórios existem (15/11/2026)
- [ ] TS-08 texto de branch protection alinhado ao estado real; gate do Billing `OK`; badges da Execução
- [x] TS-09 `soat-architecture` nos 7 repos (15/11/2026)
- [ ] TS-10 ambiente destruído e `EKS_CLUSTER_NAME` removido após a gravação
