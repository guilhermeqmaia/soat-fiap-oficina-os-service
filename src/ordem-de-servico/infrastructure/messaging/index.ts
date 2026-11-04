import {
  BillingCobrancaCriadaHandler,
  BillingOrcamentoAprovadoHandler,
  BillingOrcamentoCanceladoHandler,
  BillingOrcamentoGeradoHandler,
  BillingOrcamentoRejeitadoHandler,
  BillingPagamentoAprovadoHandler,
  BillingPagamentoRecusadoHandler,
  ExecucaoDiagnosticoConcluidoHandler,
  ExecucaoEnfileiradaHandler,
  ExecucaoFinalizadaHandler,
  ExecucaoIniciadaHandler,
  ExecucaoRecusadaHandler,
  ExecucaoReservasLiberadasHandler,
} from './eventos.handlers';

export * from './eventos.handlers';

/** Um handler por `type` assinado na fila `os-eventos.fifo` (ver infra-k8s `messaging/`). */
export const OS_MESSAGE_HANDLERS = [
  ExecucaoEnfileiradaHandler,
  ExecucaoRecusadaHandler,
  ExecucaoDiagnosticoConcluidoHandler,
  ExecucaoIniciadaHandler,
  ExecucaoFinalizadaHandler,
  ExecucaoReservasLiberadasHandler,
  BillingOrcamentoGeradoHandler,
  BillingOrcamentoAprovadoHandler,
  BillingOrcamentoRejeitadoHandler,
  BillingCobrancaCriadaHandler,
  BillingPagamentoAprovadoHandler,
  BillingPagamentoRecusadoHandler,
  BillingOrcamentoCanceladoHandler,
] as const;
