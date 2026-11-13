import { getCorrelationContext, registrarTracer, resetTracerBridge, runWithCorrelation } from '@guilhermeqmaia/oficina-kit/logging';
import { SERVICO, camposDeRastreio, comCorrelacaoDaOS, traceIdAtual } from './rastreio';

describe('rastreio (US-F4-16)', () => {
  afterEach(() => resetTracerBridge());

  it('sem APM nem contexto: sem trace_id; campos com correlation_id e servico, sem chaves undefined', () => {
    expect(traceIdAtual()).toBeUndefined();
    expect(camposDeRastreio('OS-1', { rota: 'POST /x', tentativa: undefined })).toEqual({ correlation_id: 'OS-1', servico: SERVICO, rota: 'POST /x' });
  });

  it('dentro de uma requisicao: trace_id = traceId do contexto (o do traceparent recebido)', () => {
    runWithCorrelation({ correlationId: 'req-1', traceId: 'abc' }, () => {
      expect(camposDeRastreio('OS-1')).toEqual({ trace_id: 'abc', correlation_id: 'OS-1', servico: 'os-service' });
    });
  });

  it('com APM ativo o span real tem precedencia sobre o contexto', () => {
    registrarTracer({ scope: () => ({ active: () => ({ context: () => ({ toTraceId: () => 'dd-trace-1', toSpanId: () => 's' }) }) }) } as never);
    runWithCorrelation({ correlationId: 'req-1', traceId: 'abc' }, () => expect(traceIdAtual()).toBe('dd-trace-1'));
  });

  it('comCorrelacaoDaOS troca o correlationId pelo numero da OS e mantem o trace; sem trace usa a OS como fallback', () => {
    runWithCorrelation({ correlationId: 'req-1', traceId: 'abc' }, () => {
      expect(comCorrelacaoDaOS('OS-2', () => getCorrelationContext())).toEqual({ correlationId: 'OS-2', traceId: 'abc' });
    });
    expect(comCorrelacaoDaOS('OS-3', () => getCorrelationContext())).toEqual({ correlationId: 'OS-3', traceId: 'OS-3' });
  });
});
