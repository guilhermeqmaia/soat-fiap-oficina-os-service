import { Inject, Injectable, Logger } from '@nestjs/common';
import { UseCase } from '@guilhermeqmaia/oficina-kit/core';
import { PassoSaga, StatusSaga } from '../domain/saga-os.entity';
import { SAGA_REPOSITORY, SagaRepository } from '../domain/saga.repository';
import { OrquestradorSagaService } from './orquestrador-saga.service';
import { CALLBACKS_PROCESSADOS, CallbacksProcessados } from './ports/callbacks-processados';

export interface ReceberCallbackInput {
  /** `{numero}` do path — e a correlacao do callback. */
  numero: string;
  envelope: { id: string; type: string; data: Record<string, unknown> };
}

export interface ReceberCallbackOutput {
  aplicado: boolean;
  duplicado?: boolean;
  passo?: PassoSaga;
  status?: StatusSaga;
}

/**
 * Callback dos participantes (`POST /ordens-servico/:numero/eventos`, RFC-0008):
 * deduplica pelo `id` do envelope (`processed_messages`), entrega o evento ao
 * orquestrador e marca o id como aplicado. Se o processamento falhar (409 apos
 * os retries, 404), nada e marcado e quem chamou repete o callback.
 */
@Injectable()
export class ReceberCallbackUseCase implements UseCase<ReceberCallbackInput, ReceberCallbackOutput> {
  private readonly logger = new Logger(ReceberCallbackUseCase.name);

  constructor(
    private readonly orquestrador: OrquestradorSagaService,
    @Inject(CALLBACKS_PROCESSADOS) private readonly processados: CallbacksProcessados,
    @Inject(SAGA_REPOSITORY) private readonly sagas: SagaRepository,
  ) {}

  async execute(input: ReceberCallbackInput): Promise<ReceberCallbackOutput> {
    const { id, type, data } = input.envelope;
    if (await this.processados.jaProcessado(id)) return this.duplicado(input.numero, id, type);

    const { saga, aplicado } = await this.orquestrador.processarEvento({
      type,
      id,
      data: { ...data, numeroOS: input.numero },
    });
    const novo = await this.processados.marcar(id, type);
    if (!novo) return this.duplicado(input.numero, id, type);
    return { aplicado, passo: saga.passo, status: saga.status };
  }

  private async duplicado(numero: string, id: string, type: string): Promise<ReceberCallbackOutput> {
    this.logger.warn({ msg: 'callback duplicado ignorado', numeroOS: numero, id, type });
    const saga = await this.sagas.findByNumero(numero);
    return { aplicado: false, duplicado: true, passo: saga?.passo, status: saga?.status };
  }
}
