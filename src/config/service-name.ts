/**
 * Nome deste servico nos logs (`service`), nas metricas (label `service`) e
 * no APM (`DD_SERVICE`). Nos eventos o `producer` e `os-service` (AsyncAPI);
 * aqui o nome da Fase 3 e mantido de proposito: os dashboards/monitors do
 * Datadog (US-F3-11, repo infra-k8s) filtram por `oficina-mecanica-app`.
 * Trocar os dois juntos quando os paineis forem migrados.
 */
export const SERVICE_NAME = process.env.DD_SERVICE ?? 'oficina-mecanica-app';

/** Nome deste servico nas chamadas entre servicos: `sub` do JWT de servico (RFC-0008). */
export const PRODUCER_NAME = 'os-service';
