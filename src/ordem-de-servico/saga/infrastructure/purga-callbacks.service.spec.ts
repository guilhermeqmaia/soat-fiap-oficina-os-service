import { PurgaCallbacksService } from './purga-callbacks.service';

describe('PurgaCallbacksService', () => {
  const processados = { jaProcessado: jest.fn(), marcar: jest.fn(), purgar: jest.fn() };
  beforeEach(() => jest.clearAllMocks());

  it('purga ids alem da retencao (default 7 dias)', async () => {
    processados.purgar.mockResolvedValue(5);
    const antes = Date.now();
    expect(await new PurgaCallbacksService(processados).purgar()).toBe(5);
    const limite: Date = processados.purgar.mock.calls[0][0];
    expect(antes - limite.getTime()).toBeGreaterThanOrEqual(7 * 24 * 3600 * 1000 - 1000);
    processados.purgar.mockResolvedValue(0);
    expect(await new PurgaCallbacksService(processados).purgar(1)).toBe(0);
  });

  it('nao agenda com AGENDADORES_AUTOSTART=false; agenda e cancela o timer caso contrario', () => {
    const svc = new PurgaCallbacksService(processados);
    const old = process.env.AGENDADORES_AUTOSTART;
    process.env.AGENDADORES_AUTOSTART = 'false';
    svc.onApplicationBootstrap();
    expect((svc as any).timer).toBeUndefined();
    delete process.env.AGENDADORES_AUTOSTART;
    svc.onApplicationBootstrap();
    expect((svc as any).timer).toBeDefined();
    svc.onApplicationShutdown();
    process.env.AGENDADORES_AUTOSTART = old;
  });
});
