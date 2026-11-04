import { Logger } from '@nestjs/common';
import { PassoSaga, SagaOS, StatusSaga } from '../domain/saga-os.entity';
import { ReceberCallbackUseCase } from './receber-callback.use-case';

const saga = (passo = PassoSaga.GERAR_ORCAMENTO) =>
  SagaOS.reconstitute({ id: 's1', numero: 'OS-1', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd', passo, status: StatusSaga.EM_ANDAMENTO, historico: [], compensacoes: [], prazoAprovacao: null, prazoPagamento: null, version: 1 });

describe('ReceberCallbackUseCase', () => {
  const orquestrador = { processarEvento: jest.fn() } as any;
  const processados = { jaProcessado: jest.fn(), marcar: jest.fn(), purgar: jest.fn() };
  const sagas = { findByNumero: jest.fn() } as any;
  const uc = new ReceberCallbackUseCase(orquestrador, processados, sagas);
  const envelope = { id: 'env-1', type: 'execucao.diagnostico-concluido', data: { mecanicoId: 'm', diagnostico: 'd', itens: [] } };

  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
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
});
