import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { SAGA_REPOSITORY, SagaRepository } from '../domain/saga.repository';
import { OrquestradorSagaService } from './orquestrador-saga.service';
import { sagasAguardandoPessoa, sagasParadas, sagasPorStatus } from '../../../observabilidade/metrics.registry';
import { PASSOS_AGUARDANDO_PESSOA } from '../domain/saga-os.entity';

/**
 * Relogio da saga: varre sagas com prazo de aprovacao/pagamento vencido e
 * entrega `saga.timeout` ao orquestrador (US-F4-11). Aprovacao vencida
 * compensa; pagamento vencido (pos-execucao, ADR-0012) so e registrado como
 * atraso — a OS fica retida em AGUARDANDO_PAGAMENTO. Tambem
 * atualiza as gauges de sagas por status, de sagas paradas por falha da
 * plataforma (passo automatico/compensacao ha mais de SAGA_ALERTA_PARADA_MIN
 * minutos ou comando nao entregue — insumo do alerta "saga parada";
 * `POST /admin/sagas/:numero/reprocessar` retoma) e de sagas esperando pessoa
 * (cliente/mecanico) alem do mesmo limite — informativa, sem alerta critico.
 *
 * Replicas: cada pod varre; o lock otimista da saga garante que so uma
 * aplica o timeout (a outra registra um aviso). As compensacoes decididas pelo
 * timeout saem por HTTP depois do commit (orquestrador). Desligado com
 * AGENDADORES_AUTOSTART=false (testes).
 */
@Injectable()
export class SagaTimeoutsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SagaTimeoutsService.name);
  private timer?: NodeJS.Timeout;
  private varrendo = false;

  constructor(
    @Inject(SAGA_REPOSITORY) private readonly sagas: SagaRepository,
    private readonly orquestrador: OrquestradorSagaService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.AGENDADORES_AUTOSTART === 'false') return;
    const intervalo = Number(process.env.SAGA_TIMEOUTS_INTERVALO_MS ?? 60_000);
    this.timer = setInterval(() => void this.varrer().catch((e) => this.logger.warn({ msg: 'varredura falhou', erro: (e as Error).message })), intervalo);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Um ciclo (sem reentrancia): timeouts vencidos -> orquestrador; gauges. Devolve quantas sagas expiraram. */
  async varrer(agora: Date = new Date()): Promise<number> {
    if (this.varrendo) return 0;
    this.varrendo = true;
    try {
      const vencidas = await this.sagas.findComPrazoVencido(agora);
      for (const saga of vencidas) {
        try {
          await this.orquestrador.processar({ type: 'saga.timeout', data: { numeroOS: saga.numero, passo: saga.passo } }, agora);
        } catch (e) {
          this.logger.warn({ msg: 'timeout nao aplicado', numeroOS: saga.numero, erro: (e as Error).message });
        }
      }
      const porStatus = await this.sagas.countPorStatus();
      for (const status of ['EM_ANDAMENTO', 'COMPENSANDO', 'CONCLUIDA', 'CANCELADA']) sagasPorStatus.set({ status }, porStatus[status] ?? 0);
      const limiteMin = Number(process.env.SAGA_ALERTA_PARADA_MIN ?? 60);
      const desde = new Date(agora.getTime() - limiteMin * 60_000);
      const paradas = await this.sagas.countParadasDesde(desde);
      sagasParadas.set(paradas);
      if (paradas > 0) this.logger.warn({ msg: 'sagas paradas (passo automatico/compensacao ou comando nao entregue)', quantidade: paradas, limiteMin });
      const aguardandoPessoa = await this.sagas.countAguardandoPessoaDesde(desde);
      for (const passo of PASSOS_AGUARDANDO_PESSOA) sagasAguardandoPessoa.set({ passo }, aguardandoPessoa[passo] ?? 0);
      return vencidas.length;
    } finally {
      this.varrendo = false;
    }
  }
}
