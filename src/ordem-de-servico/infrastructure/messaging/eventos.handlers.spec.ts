import { Test } from '@nestjs/testing';
import { criarEnvelope } from '@guilhermeqmaia/oficina-kit/messaging';
import { OrquestradorSagaService } from '../../saga/application/orquestrador-saga.service';
import { OS_MESSAGE_HANDLERS } from './index';
import { ExecucaoDiagnosticoConcluidoHandler, ExecucaoEnfileiradaHandler } from './eventos.handlers';

describe('handlers da fila os-eventos (-> orquestrador da saga)', () => {
  const orquestrador = { processar: jest.fn().mockResolvedValue(undefined) };
  let get: <T>(cls: new (...a: any[]) => T) => T;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ providers: [...OS_MESSAGE_HANDLERS, { provide: OrquestradorSagaService, useValue: orquestrador }] }).compile();
    get = (cls) => module.get(cls);
  });
  beforeEach(() => jest.clearAllMocks());

  it('cobre os 13 types assinados na fila, sem duplicatas', () => {
    const types = OS_MESSAGE_HANDLERS.map((h) => get<{ type: string }>(h as any).type);
    expect(new Set(types).size).toBe(types.length);
    expect(types.sort()).toEqual([
      'billing.cobranca-criada', 'billing.orcamento-aprovado', 'billing.orcamento-cancelado', 'billing.orcamento-gerado', 'billing.orcamento-rejeitado', 'billing.pagamento-aprovado', 'billing.pagamento-recusado',
      'execucao.diagnostico-concluido', 'execucao.enfileirada', 'execucao.finalizada', 'execucao.iniciada', 'execucao.recusada', 'execucao.reservas-liberadas',
    ]);
  });

  it('entrega type, id e data do envelope ao orquestrador', async () => {
    const env = criarEnvelope({ type: 'execucao.enfileirada', data: { numeroOS: 'OS-1', posicaoFila: 2 }, producer: 'execucao-service', correlationId: 'OS-1' });
    await get(ExecucaoEnfileiradaHandler).handle(env);
    expect(orquestrador.processar).toHaveBeenCalledWith({ type: 'execucao.enfileirada', id: env.id, data: { numeroOS: 'OS-1', posicaoFila: 2 } });
  });

  it('erro do orquestrador propaga (o consumer nao confirma -> retry -> DLQ)', async () => {
    orquestrador.processar.mockRejectedValueOnce(new Error('OS nao encontrada'));
    const env = criarEnvelope({ type: 'execucao.diagnostico-concluido', data: { numeroOS: 'OS-X' }, producer: 'execucao-service', correlationId: 'OS-X' });
    await expect(get(ExecucaoDiagnosticoConcluidoHandler).handle(env)).rejects.toThrow('OS nao encontrada');
  });
});
