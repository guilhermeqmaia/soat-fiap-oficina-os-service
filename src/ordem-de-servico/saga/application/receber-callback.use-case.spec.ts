import { Logger } from '@nestjs/common';
import { PassoSaga, SagaOS, StatusSaga } from '../domain/saga-os.entity';
import { ReceberCallbackUseCase } from './receber-callback.use-case';
import { callbacksTotal, inicializarSeriesDeNegocio } from '../../../observabilidade/metrics.registry';
import { runWithCorrelation } from '@guilhermeqmaia/oficina-kit/logging';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { OrdemDeServicoNotFoundError } from '../../domain/errors/ordem-de-servico-not-found.error';

const contador = async (type: string, resultado: string) =>
  (await callbacksTotal.get()).values.find((v) => v.labels.type === type && v.labels.resultado === resultado)?.value ?? 0;

const saga = (passo = PassoSaga.GERAR_ORCAMENTO) =>
  SagaOS.reconstitute({ id: 's1', numero: 'OS-1', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd', passo, status: StatusSaga.EM_ANDAMENTO, historico: [], compensacoes: [], prazoAprovacao: null, prazoPagamento: null, version: 1 });

describe('ReceberCallbackUseCase', () => {
  const orquestrador = { processarEvento: jest.fn() } as any;
  const processados = { jaProcessado: jest.fn(), marcar: jest.fn(), purgar: jest.fn() };
  const sagas = { findByNumero: jest.fn() } as any;
  const uc = new ReceberCallbackUseCase(orquestrador, processados, sagas);
  const envelope = { id: 'env-1', type: 'execucao.diagnostico-concluido', data: { mecanicoId: 'm', diagnostico: 'd', itens: [] } };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());
  beforeEach(() => jest.clearAllMocks());

  it('entrega o evento ao orquestrador com numeroOS do path, marca o id e devolve aplicado/passo/status', async () => {
    processados.jaProcessado.mockResolvedValue(false);
    processados.marcar.mockResolvedValue(true);
    orquestrador.processarEvento.mockResolvedValue({ saga: saga(PassoSaga.AGUARDAR_APROVACAO), aplicado: true });
    const r = await uc.execute({ numero: 'OS-1', envelope });
    expect(orquestrador.processarEvento).toHaveBeenCalledWith({ type: envelope.type, id: 'env-1', data: { ...envelope.data, numeroOS: 'OS-1' } });
    expect(processados.marcar).toHaveBeenCalledWith('env-1', envelope.type);
    expect(r).toEqual({ aplicado: true, passo: PassoSaga.AGUARDAR_APROVACAO, status: StatusSaga.EM_ANDAMENTO });
  });

  it('evento ignorado pela saga: aplicado=false, mas o id e marcado (reentrega nao reprocessa)', async () => {
    processados.jaProcessado.mockResolvedValue(false);
    processados.marcar.mockResolvedValue(true);
    orquestrador.processarEvento.mockResolvedValue({ saga: saga(), aplicado: false, motivo: 'duplicado' });
    expect(await uc.execute({ numero: 'OS-1', envelope })).toEqual({ aplicado: false, passo: PassoSaga.GERAR_ORCAMENTO, status: StatusSaga.EM_ANDAMENTO });
    expect(processados.marcar).toHaveBeenCalled();
  });

  it('id ja processado: responde duplicado com o estado atual da saga, sem chamar o orquestrador', async () => {
    processados.jaProcessado.mockResolvedValue(true);
    sagas.findByNumero.mockResolvedValue(saga());
    expect(await uc.execute({ numero: 'OS-1', envelope })).toEqual({ aplicado: false, duplicado: true, passo: PassoSaga.GERAR_ORCAMENTO, status: StatusSaga.EM_ANDAMENTO });
    expect(orquestrador.processarEvento).not.toHaveBeenCalled();
    sagas.findByNumero.mockResolvedValue(null);
    expect(await uc.execute({ numero: 'OS-9', envelope })).toEqual({ aplicado: false, duplicado: true, passo: undefined, status: undefined });
  });

  it('corrida entre duas entregas do mesmo id: a que perde a marcacao responde duplicado', async () => {
    processados.jaProcessado.mockResolvedValue(false);
    processados.marcar.mockResolvedValue(false);
    orquestrador.processarEvento.mockResolvedValue({ saga: saga(), aplicado: false });
    sagas.findByNumero.mockResolvedValue(saga());
    expect(await uc.execute({ numero: 'OS-1', envelope })).toMatchObject({ duplicado: true });
  });

  it('erro do orquestrador (409/404) sobe sem marcar o id — quem chamou repete o callback', async () => {
    processados.jaProcessado.mockResolvedValue(false);
    orquestrador.processarEvento.mockRejectedValue(new Error('conflito'));
    await expect(uc.execute({ numero: 'OS-1', envelope })).rejects.toThrow('conflito');
    expect(processados.marcar).not.toHaveBeenCalled();
  });

  describe('oficina_callbacks_total{type,resultado} (US-F4-16)', () => {
    const T = 'execucao.diagnostico-concluido';
    beforeAll(() => inicializarSeriesDeNegocio());

    it('aplicado', async () => {
      const antes = await contador(T, 'aplicado');
      processados.jaProcessado.mockResolvedValue(false); processados.marcar.mockResolvedValue(true);
      orquestrador.processarEvento.mockResolvedValue({ saga: saga(), aplicado: true });
      await uc.execute({ numero: 'OS-1', envelope });
      expect(await contador(T, 'aplicado')).toBe(antes + 1);
    });

    it('duplicado: id ja processado, corrida na marcacao ou passo ja concluido na saga', async () => {
      const antes = await contador(T, 'duplicado');
      processados.jaProcessado.mockResolvedValueOnce(true);
      sagas.findByNumero.mockResolvedValue(saga());
      await uc.execute({ numero: 'OS-1', envelope });
      processados.jaProcessado.mockResolvedValue(false); processados.marcar.mockResolvedValueOnce(false);
      orquestrador.processarEvento.mockResolvedValue({ saga: saga(), aplicado: false });
      await uc.execute({ numero: 'OS-1', envelope });
      processados.marcar.mockResolvedValue(true);
      orquestrador.processarEvento.mockResolvedValue({ saga: saga(), aplicado: false, motivo: 'duplicado (passo ja concluido)' });
      await uc.execute({ numero: 'OS-1', envelope });
      expect(await contador(T, 'duplicado')).toBe(antes + 3);
    });

    it('ignorado: fora de ordem para a saga (200 com aplicado=false)', async () => {
      const antes = await contador(T, 'ignorado');
      processados.jaProcessado.mockResolvedValue(false); processados.marcar.mockResolvedValue(true);
      orquestrador.processarEvento.mockResolvedValue({ saga: saga(), aplicado: false, motivo: 'fora de ordem (esperado no passo X)' });
      const r = await uc.execute({ numero: 'OS-1', envelope });
      expect(r).not.toHaveProperty('motivo'); // o motivo so vai para o log, nao para a resposta
      expect(await contador(T, 'ignorado')).toBe(antes + 1);
    });

    it('conflito (409), nao_encontrado (404) e erro (5xx) — o erro continua subindo', async () => {
      const antes = { c: await contador(T, 'conflito'), n: await contador(T, 'nao_encontrado'), e: await contador(T, 'erro') };
      processados.jaProcessado.mockResolvedValue(false);
      orquestrador.processarEvento.mockRejectedValueOnce(new ConcurrentModificationError('OS-1'));
      await expect(uc.execute({ numero: 'OS-1', envelope })).rejects.toThrow(ConcurrentModificationError);
      orquestrador.processarEvento.mockRejectedValueOnce(new OrdemDeServicoNotFoundError('OS-1'));
      await expect(uc.execute({ numero: 'OS-1', envelope })).rejects.toThrow(OrdemDeServicoNotFoundError);
      orquestrador.processarEvento.mockRejectedValueOnce(new Error('banco fora'));
      await expect(uc.execute({ numero: 'OS-1', envelope })).rejects.toThrow('banco fora');
      expect(await contador(T, 'conflito')).toBe(antes.c + 1);
      expect(await contador(T, 'nao_encontrado')).toBe(antes.n + 1);
      expect(await contador(T, 'erro')).toBe(antes.e + 1);
    });

    it('type fora do contrato vira type="outro" (cardinalidade fixa)', async () => {
      const antes = await contador('outro', 'ignorado');
      processados.jaProcessado.mockResolvedValue(false); processados.marcar.mockResolvedValue(true);
      orquestrador.processarEvento.mockResolvedValue({ saga: saga(), aplicado: false, motivo: 'evento desconhecido' });
      await uc.execute({ numero: 'OS-1', envelope: { ...envelope, type: 'xpto.qualquer-coisa' } });
      expect(await contador('outro', 'ignorado')).toBe(antes + 1);
      expect(await contador('xpto.qualquer-coisa', 'ignorado')).toBe(0);
    });

    it('linha de log com trace_id (do traceparent recebido), correlation_id, servico, rota, tentativa e resultado', async () => {
      processados.jaProcessado.mockResolvedValue(false); processados.marcar.mockResolvedValue(true);
      orquestrador.processarEvento.mockResolvedValue({ saga: saga(), aplicado: true });
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      await runWithCorrelation({ correlationId: 'req-1', traceId }, () =>
        uc.execute({ numero: 'OS-1', envelope: { ...envelope, producer: 'execucao-service' }, tentativa: 2 }),
      );
      expect(Logger.prototype.log).toHaveBeenCalledWith({
        msg: 'callback recebido',
        trace_id: traceId,
        correlation_id: 'OS-1',
        servico: 'os-service',
        rota: 'POST /ordens-servico/{numero}/eventos',
        tentativa: 2,
        numeroOS: 'OS-1',
        id: 'env-1',
        type: T,
        producer: 'execucao-service',
        resultado: 'aplicado',
        motivo: undefined,
      });
    });
  });
});
