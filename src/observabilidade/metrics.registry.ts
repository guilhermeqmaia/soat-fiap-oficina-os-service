import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '@guilhermeqmaia/oficina-kit/metrics';

/**
 * Metricas de NEGOCIO deste servico (US-F3-10), registradas no registry
 * unico do kit — a infra de scrape (`/metrics`, latencia HTTP, processo) vem
 * do `MetricsModule` do kit (ADR-0010).
 */
export { registry };

/** Volume de OS por transicao de status — alimenta os dashboards da US-F3-11. */
export const osTransicoes = new Counter({
  name: 'oficina_os_transicoes_total',
  help: 'Transicoes de status de ordens de servico',
  labelNames: ['de', 'para'] as const,
  registers: [registry],
});

/** Tempo de permanencia em cada status (fecha quando a OS sai do status). */
export const osTempoNoStatus = new Histogram({
  name: 'oficina_os_tempo_no_status_seconds',
  help: 'Tempo que a OS permaneceu em cada status antes de transicionar',
  labelNames: ['status'] as const,
  buckets: [60, 300, 900, 3600, 14400, 86400, 259200],
  registers: [registry],
});

/**
 * Resultado das integracoes (notificacao/webhook e chamadas HTTP a Execucao e
 * Billing) — insumo do alerta de "falha no processamento de OS" (US-F3-11).
 *
 * @deprecated para `integracao=execucao-service|billing-service`: use
 * `oficina_http_interno_total` (nome unico decidido na US-F4-16). As series dos
 * participantes continuam sendo emitidas enquanto o painel "Erros de
 * integracao" do dashboard de negocio (infra-k8s `observability/dashboards.tf`)
 * as consultar. `integracao=webhook-notificacao` NAO e deprecated (alimenta o
 * monitor `falha_notificacao`).
 */
export const integracaoResultados = new Counter({
  name: 'oficina_integracoes_total',
  help: 'Resultado das integracoes externas (notificacao, webhook, execucao-service, billing-service)',
  labelNames: ['integracao', 'resultado'] as const,
  registers: [registry],
});

/** Saga orquestrada (US-F4-10): resultado de cada evento por passo. */
export const sagaPassos = new Counter({
  name: 'oficina_os_saga_passos_total',
  help: 'Eventos processados pelo orquestrador da saga, por passo e resultado',
  labelNames: ['passo', 'resultado'] as const,
  registers: [registry],
});

/** Tempo entre entrar num passo e sair dele (so para passos avancados). */
export const sagaPassoDuracao = new Histogram({
  name: 'oficina_os_saga_passo_duracao_seconds',
  help: 'Duracao de cada passo da saga',
  labelNames: ['passo'] as const,
  buckets: [10, 60, 300, 900, 3600, 14400, 86400, 259200],
  registers: [registry],
});

/** Sagas por status (atualizado pelo varredor de timeouts). */
export const sagasPorStatus = new Gauge({
  name: 'oficina_os_sagas',
  help: 'Quantidade de sagas por status (EM_ANDAMENTO, COMPENSANDO, CONCLUIDA, CANCELADA)',
  labelNames: ['status'] as const,
  registers: [registry],
});

/** Sagas EM_ANDAMENTO paradas no mesmo passo alem de SAGA_ALERTA_PARADA_MIN (alerta "saga travada"). */
export const sagasParadas = new Gauge({
  name: 'oficina_os_sagas_paradas',
  help: 'Sagas em andamento sem avancar de passo ha mais tempo que o limite configurado',
  registers: [registry],
});

// ─── Fluxo distribuido (US-F4-16 / US-F4-18) ─────────────────────────────────
//
// TODO(kit): `oficina_http_interno_total`, `oficina_http_interno_duracao_seconds`
// e `oficina_callbacks_total` sao "metricas do kit" pela US-F4-16, mas o
// `@guilhermeqmaia/oficina-kit` 0.3.0 ainda nao as tem. Ficam aqui com os nomes e
// labels definitivos; quando o kit publicar (release minor + bump nos 3
// servicos), apagar estas definicoes e importar de `@guilhermeqmaia/oficina-kit/metrics`
// — os nomes nao mudam, entao dashboards/monitores nao precisam mudar.

/** Este servico como `origem` das chamadas internas. */
export const ORIGEM_HTTP_INTERNO = 'os-service';

/**
 * Resultado de cada chamada interna (comando da saga) por par origem->destino:
 * `sucesso` (2xx, ou 409 "ja existe" tratado como sucesso), `recusa` (409 de
 * negocio), `esgotado` (5xx/timeout/rede depois das 3 tentativas — alerta "retry
 * esgotado") e `erro` (outro 4xx, ex.: 404/401: erro de configuracao, sem retry).
 */
export const httpInternoTotal = new Counter({
  name: 'oficina_http_interno_total',
  help: 'Chamadas HTTP entre servicos por origem, destino, rota e resultado (sucesso|recusa|esgotado|erro)',
  labelNames: ['origem', 'destino', 'rota', 'resultado'] as const,
  registers: [registry],
});

/**
 * Duracao de cada chamada interna, do ponto de vista de quem chama (inclui as
 * retentativas e o backoff do cliente do kit). `status` = codigo HTTP da ultima
 * resposta ou `sem_resposta` (timeout/erro de rede).
 */
export const httpInternoDuracao = new Histogram({
  name: 'oficina_http_interno_duracao_seconds',
  help: 'Duracao das chamadas HTTP entre servicos (inclui retentativas)',
  labelNames: ['origem', 'destino', 'rota', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
  registers: [registry],
});

/**
 * Callbacks recebidos em `POST /ordens-servico/{numero}/eventos`, por `type` e
 * resultado: `aplicado`, `duplicado` (id ja processado, ou passo ja concluido),
 * `ignorado` (fora de ordem / desconhecido para a saga: 200 com aplicado=false),
 * `conflito` (409), `nao_encontrado` (404) e `erro` (5xx).
 */
export const callbacksTotal = new Counter({
  name: 'oficina_callbacks_total',
  help: 'Callbacks dos participantes por type e resultado (aplicado|duplicado|ignorado|conflito|nao_encontrado|erro)',
  labelNames: ['type', 'resultado'] as const,
  registers: [registry],
});

export const DESTINOS_HTTP_INTERNO = ['execucao-service', 'billing-service'] as const;
export type DestinoHttpInterno = (typeof DESTINOS_HTTP_INTERNO)[number];

/**
 * Rotas (template, sem o numero da OS — cardinalidade fixa) que o orquestrador
 * chama, por destino. `rotaDoComando` usa exatamente estes valores (teste em
 * `http-participantes-saga.spec.ts`).
 */
export const ROTAS_HTTP_INTERNO: ReadonlyArray<{ destino: DestinoHttpInterno; rota: string }> = [
  { destino: 'execucao-service', rota: 'POST /execucao/ordens' },
  { destino: 'execucao-service', rota: 'POST /execucao/ordens/{numero}/iniciar' },
  { destino: 'execucao-service', rota: 'DELETE /execucao/ordens/{numero}' },
  { destino: 'billing-service', rota: 'POST /orcamentos' },
  { destino: 'billing-service', rota: 'POST /orcamentos/{numero}/cobrar' },
  { destino: 'billing-service', rota: 'DELETE /orcamentos/{numero}' },
];
export const RESULTADOS_HTTP_INTERNO = ['sucesso', 'recusa', 'esgotado', 'erro'] as const;
export type ResultadoHttpInterno = (typeof RESULTADOS_HTTP_INTERNO)[number];

/** Callbacks que os participantes enviam (contrato `docs/contratos/http-interno.md`). */
export const TIPOS_CALLBACK = [
  'execucao.diagnostico-concluido',
  'execucao.finalizada',
  'billing.orcamento-aprovado',
  'billing.orcamento-rejeitado',
  'billing.pagamento-aprovado',
  'billing.pagamento-recusado',
] as const;
export const RESULTADOS_CALLBACK = ['aplicado', 'duplicado', 'ignorado', 'conflito', 'nao_encontrado', 'erro'] as const;
export type ResultadoCallback = (typeof RESULTADOS_CALLBACK)[number];

/**
 * `type` como label: so os tipos do contrato; qualquer outro vira `outro` (o
 * DTO so valida o formato `<dominio>.<fato>` — sem isto um produtor com bug
 * criaria uma serie por valor).
 */
export function tipoCallbackDaMetrica(type: string): string {
  return (TIPOS_CALLBACK as readonly string[]).includes(type) ? type : 'outro';
}

/**
 * Pre-registra as series de negocio com valor 0. Contadores/histogramas com
 * labels so aparecem no /metrics depois do primeiro evento; sem isto os
 * dashboards (US-F3-11) mostram "No Data" em vez de 0 ate a primeira OS
 * transicionar em cada pod — ruim para a demo e para os alertas.
 */
export function inicializarSeriesDeNegocio(): void {
  const transicoes: Array<[string, string]> = [
    ['RECEBIDA', 'EM_DIAGNOSTICO'],
    ['EM_DIAGNOSTICO', 'AGUARDANDO_APROVACAO'],
    ['AGUARDANDO_APROVACAO', 'EM_EXECUCAO'],
    ['AGUARDANDO_APROVACAO', 'CANCELADA'],
    ['EM_EXECUCAO', 'AGUARDANDO_PAGAMENTO'],
    ['AGUARDANDO_PAGAMENTO', 'FINALIZADA'],
    ['FINALIZADA', 'ENTREGUE'],
  ];
  for (const [de, para] of transicoes) osTransicoes.inc({ de, para }, 0);
  for (const status of ['RECEBIDA', 'EM_DIAGNOSTICO', 'AGUARDANDO_APROVACAO', 'EM_EXECUCAO', 'AGUARDANDO_PAGAMENTO', 'FINALIZADA']) {
    osTempoNoStatus.zero({ status });
  }
  for (const resultado of ['sucesso', 'falha']) {
    integracaoResultados.inc({ integracao: 'webhook-notificacao', resultado }, 0);
  }
  // Chamadas HTTP aos participantes da saga (RFC-0008)
  for (const integracao of ['execucao-service', 'billing-service']) {
    for (const resultado of ['sucesso', 'recusado', 'falha']) integracaoResultados.inc({ integracao, resultado }, 0);
  }
  // Fluxo distribuido (US-F4-16): uma serie por destino/resultado e por type/resultado
  for (const { destino, rota } of ROTAS_HTTP_INTERNO) {
    for (const resultado of RESULTADOS_HTTP_INTERNO) {
      httpInternoTotal.inc({ origem: ORIGEM_HTTP_INTERNO, destino, rota, resultado }, 0);
    }
  }
  for (const type of [...TIPOS_CALLBACK, 'outro']) {
    for (const resultado of RESULTADOS_CALLBACK) callbacksTotal.inc({ type, resultado }, 0);
  }
  for (const status of ['EM_ANDAMENTO', 'COMPENSANDO', 'CONCLUIDA', 'CANCELADA']) sagasPorStatus.set({ status }, 0);
  sagasParadas.set(0);
  for (const resultado of ['avancou', 'ignorado', 'compensando', 'concluida', 'cancelada', 'comando-falhou', 'resposta-falhou']) {
    sagaPassos.inc({ passo: 'ENFILEIRAR_EXECUCAO', resultado }, 0);
  }
}
