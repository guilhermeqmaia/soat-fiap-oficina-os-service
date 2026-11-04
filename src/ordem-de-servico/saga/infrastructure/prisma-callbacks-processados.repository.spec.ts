import { PrismaCallbacksProcessadosRepository } from './prisma-callbacks-processados.repository';

describe('PrismaCallbacksProcessadosRepository (unit)', () => {
  const prisma = { processedMessage: { findUnique: jest.fn(), create: jest.fn(), deleteMany: jest.fn() } } as any;
  const repo = new PrismaCallbacksProcessadosRepository(prisma);
  beforeEach(() => jest.clearAllMocks());

  it('jaProcessado consulta pela PK', async () => {
    prisma.processedMessage.findUnique.mockResolvedValueOnce({ id: 'a' }).mockResolvedValueOnce(null);
    expect(await repo.jaProcessado('a')).toBe(true);
    expect(await repo.jaProcessado('b')).toBe(false);
    expect(prisma.processedMessage.findUnique).toHaveBeenCalledWith({ where: { id: 'a' } });
  });

  it('marcar grava id+type; PK duplicada devolve false; outros erros sobem', async () => {
    prisma.processedMessage.create.mockResolvedValueOnce({});
    expect(await repo.marcar('a', 'x.y')).toBe(true);
    expect(prisma.processedMessage.create).toHaveBeenCalledWith({ data: { id: 'a', type: 'x.y' } });
    prisma.processedMessage.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    expect(await repo.marcar('a', 'x.y')).toBe(false);
    prisma.processedMessage.create.mockRejectedValueOnce(new Error('db fora'));
    await expect(repo.marcar('a', 'x.y')).rejects.toThrow('db fora');
  });

  it('purgar apaga antes da data e devolve a contagem', async () => {
    prisma.processedMessage.deleteMany.mockResolvedValue({ count: 4 });
    const antesDe = new Date();
    expect(await repo.purgar(antesDe)).toBe(4);
    expect(prisma.processedMessage.deleteMany).toHaveBeenCalledWith({ where: { processadaEm: { lt: antesDe } } });
  });
});
