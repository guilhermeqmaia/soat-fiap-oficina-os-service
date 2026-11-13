import { BadRequestException } from '@nestjs/common';
import { CallbackSagaController } from './callback-saga.controller';
import { EnvelopeCallbackDto } from './dto/envelope-callback.dto';

describe('CallbackSagaController', () => {
  const receber = { execute: jest.fn().mockResolvedValue({ aplicado: true }) };
  const controller = new CallbackSagaController(receber as never);
  const dto = (data: Record<string, unknown> = {}): EnvelopeCallbackDto => ({
    id: '0192f3a0-7c6e-7d2a-9b1e-3f4c5d6e7f80',
    type: 'execucao.finalizada',
    version: 1,
    occurredAt: '2026-11-10T12:00:00Z',
    producer: 'execucao-service',
    data,
  });

  beforeEach(() => receber.execute.mockClear());

  it('repassa envelope, producer e a tentativa do header x-tentativa (so inteiro positivo)', async () => {
    await controller.receberEvento('OS-1', dto(), '2');
    expect(receber.execute).toHaveBeenCalledWith({
      numero: 'OS-1',
      envelope: { id: dto().id, type: 'execucao.finalizada', data: {}, producer: 'execucao-service' },
      tentativa: 2,
    });
    for (const invalido of [undefined, '', 'abc', '0', '-1']) {
      await controller.receberEvento('OS-1', dto(), invalido);
      expect(receber.execute).toHaveBeenLastCalledWith(expect.objectContaining({ tentativa: undefined }));
    }
  });

  it('400 quando data.numeroOS diverge do path (antes de tocar a saga)', async () => {
    await expect(controller.receberEvento('OS-1', dto({ numeroOS: 'OS-2' }))).rejects.toThrow(BadRequestException);
    expect(receber.execute).not.toHaveBeenCalled();
  });
});
