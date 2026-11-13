import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError, DomainErrorKind, UseCase } from '@guilhermeqmaia/oficina-kit/core';
import { ResultadoCallback, callbacksTotal, tipoCallbackDaMetrica } from '../../../observabilidade/metrics.registry';
import { camposDeRastreio } from '../../../observabilidade/rastreio';
import { PassoSaga, StatusSaga } from '../domain/saga-os.entity';
import { SAGA_REPOSITORY, SagaRepository } from '../domain/saga.repository';
import { OrquestradorSagaService } from './orquestrador-saga.service';
import { CALLBACKS_PROCESSADOS, CallbacksProcessados } from './ports/callbacks-processados';

export interface ReceberCallbackInput {
  /** `{numero}` do path — e a correlacao do callback. */
  numero: string;
  envelope: { id: string; type: string; data: Record<string, unknown>; producer?: string };
  /** Tentativa do participante (header opcional `x-tentativa`), so para o log. */
  tentativa?: number;
}

/** Rota do callback nos logs (template, sem o numero). */
export const ROTA_CALLBACK = 'POST /ordens-servico/{numero}/eventos';

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
 *
 * Observabilidade (US-F4-16): cada callback conta em
 * `oficina_callbacks_total{type,resultado}` e gera uma linha de log com
 * `trace_id` (o do `traceparent` recebido), `correlation_id`, `servico`, `rota`,
 * `tentativa`, `type`, `id` e `resultado`.
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
    try {
      const saida = await this.processar(input);
      this.contar(input, this.resultadoDe(saida), saida.motivo);
      const { motivo: _motivo, ...resposta } = saida;
      return resposta;
    } catch (e) {
      this.contar(input, resultadoDoErro(e), (e as Error).message);
      throw e;
    }
  }

  private async processar(input: ReceberCallbackInput): Promise<ReceberCallbackOutput & { motivo?: string }> {
    const { id, type, data } = input.envelope;
    if (await this.processados.jaProcessado(id)) return this.duplicado(input.numero);

    const { saga, aplicado, motivo } = await this.orquestrador.processarEvento({
      type,
      id,
      data: { ...data, numeroOS: input.numero },
    });
    const novo = await this.processados.marcar(id, type);
    if (!novo) return this.duplicado(input.numero);
    return { aplicado, passo: saga.passo, status: saga.status, motivo };
  }

  private resultadoDe(saida: ReceberCallbackOutput & { motivo?: string }): ResultadoCallback {
    if (saida.duplicado) return 'duplicado';
    if (saida.aplicado) return 'aplicado';
    // A saga ignorou o evento: repeticao de um passo ja concluido conta como duplicado;
    // fora de ordem / desconhecido e "ignorado" (200 com aplicado=false).
    return saida.motivo?.startsWith('duplicado') ? 'duplicado' : 'ignorado';
  }

  private contar(input: ReceberCallbackInput, resultado: ResultadoCallback, motivo?: string): void {
    const { id, type, producer } = input.envelope;
    callbacksTotal.inc({ type: tipoCallbackDaMetrica(type), resultado });
    const linha = {
      msg: 'callback recebido',
      ...camposDeRastreio(input.numero, { rota: ROTA_CALLBACK, tentativa: input.tentativa }),
      numeroOS: input.numero,
      id,
      type,
      producer,
      resultado,
      motivo,
    };
    if (resultado === 'aplicado') this.logger.log(linha);
    else if (resultado === 'erro') this.logger.error(linha);
    else this.logger.warn(linha);
  }

  private async duplicado(numero: string): Promise<ReceberCallbackOutput> {
    const saga = await this.sagas.findByNumero(numero);
    return { aplicado: false, duplicado: true, passo: saga?.passo, status: saga?.status };
  }
}

/** 409 (conflito de versao persistente) / 404 (OS inexistente) / resto = erro (5xx). */
function resultadoDoErro(e: unknown): ResultadoCallback {
  if (e instanceof DomainError) {
    if (e.kind === DomainErrorKind.CONFLICT) return 'conflito';
    if (e.kind === DomainErrorKind.NOT_FOUND) return 'nao_encontrado';
  }
  return 'erro';
}
