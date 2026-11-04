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
  for (const status of ['EM_ANDAMENTO', 'COMPENSANDO', 'CONCLUIDA', 'CANCELADA']) sagasPorStatus.set({ status }, 0);
  sagasParadas.set(0);
  for (const resultado of ['avancou', 'ignorado', 'compensando', 'concluida', 'cancelada', 'comando-falhou', 'resposta-falhou']) {
    sagaPassos.inc({ passo: 'ENFILEIRAR_EXECUCAO', resultado }, 0);
  }
}
