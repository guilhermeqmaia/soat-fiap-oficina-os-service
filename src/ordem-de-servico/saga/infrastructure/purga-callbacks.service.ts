import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { CALLBACKS_PROCESSADOS, CallbacksProcessados } from '../application/ports/callbacks-processados';

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Purga periodica de `processed_messages` (dedup de callbacks): ids mais antigos
 * que CALLBACKS_RETENCAO_DIAS (default 7) sao apagados a cada
 * CALLBACKS_PURGA_INTERVALO_MS (default 1 h). Desligada com
 * AGENDADORES_AUTOSTART=false (testes); `purgar()` fica exposto.
 */
@Injectable()
export class PurgaCallbacksService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PurgaCallbacksService.name);
  private timer?: NodeJS.Timeout;

  constructor(@Inject(CALLBACKS_PROCESSADOS) private readonly processados: CallbacksProcessados) {}

  onApplicationBootstrap(): void {
    if (process.env.AGENDADORES_AUTOSTART === 'false') return;
    const intervalo = Number(process.env.CALLBACKS_PURGA_INTERVALO_MS ?? 60 * 60 * 1000);
    this.timer = setInterval(
      () => void this.purgar().catch((e) => this.logger.warn({ msg: 'purga falhou', erro: (e as Error).message })),
      intervalo,
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Remove o que ja cumpriu a retencao; devolve a contagem apagada. */
  async purgar(retencaoDias = Number(process.env.CALLBACKS_RETENCAO_DIAS ?? 7)): Promise<number> {
    const apagados = await this.processados.purgar(new Date(Date.now() - retencaoDias * DIA_MS));
    if (apagados) this.logger.log({ msg: 'purga de callbacks processados', apagados, retencaoDias });
    return apagados;
  }
}
