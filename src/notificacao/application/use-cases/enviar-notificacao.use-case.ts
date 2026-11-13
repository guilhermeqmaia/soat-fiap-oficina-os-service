import { Inject, Injectable, Logger } from '@nestjs/common';
import { UseCase } from '@guilhermeqmaia/oficina-kit/core';
import { Notificacao } from '../../domain/notificacao.entity';
import { CanalNotificacao } from '../../domain/value-objects/canal-notificacao.vo';
import { TipoNotificacao } from '../../domain/value-objects/tipo-notificacao.vo';
import { NOTIFICADOR, Notificador } from '../ports/notificador.port';
import {
  NOTIFICACAO_GATEWAY,
  NotificacaoGateway,
} from '../gateways/notificacao.gateway';

export interface EnviarNotificacaoInput {
  clienteId: string;
  ordemDeServicoId?: string;
  /** Numero da OS (US-F4-12). */
  numeroOS?: string;
  /** Id do fato de origem: com `tipo` + canal, garante uma notificacao por fato. */
  eventoId?: string;
  linkPagamento?: string;
  tipo: TipoNotificacao;
  /**
   * Canal especifico. Omitido = todos os notificadores registrados (o provider
   * ativo, `NOTIFICATION_PROVIDER`) — a notificacao e gravada com o canal REAL
   * de cada um (WEBHOOK para o webhook, EMAIL para e-mail).
   */
  canal?: CanalNotificacao;
  /** E-mail do cliente. Sem e-mail, o canal EMAIL e pulado; o WEBHOOK identifica o cliente pelo payload. */
  destinatario: string | null;
  assunto: string;
  mensagem: string;
  statusAnterior?: string;
  statusAtual?: string;
  timestamp?: Date | string;
}

/**
 * Envia uma notificacao por canal, de forma idempotente (US-F4-12):
 *
 * 1. reserva a linha (`PENDENTE`) — se o indice unico (eventoId, tipo, canal)
 *    acusar que o fato ja foi notificado, registra "ja notificado" (warn) e
 *    NAO reenvia;
 * 2. envia pelo notificador do canal;
 * 3. grava o resultado (`ENVIADA` / `FALHOU`).
 *
 * Devolve as notificacoes efetivamente processadas (as ja notificadas ficam de fora).
 */
@Injectable()
export class EnviarNotificacaoUseCase
  implements UseCase<EnviarNotificacaoInput, Notificacao[]>
{
  private readonly logger = new Logger(EnviarNotificacaoUseCase.name);
  private readonly notificadoresPorCanal: Map<CanalNotificacao, Notificador>;

  constructor(
    @Inject(NOTIFICACAO_GATEWAY)
    private readonly gateway: NotificacaoGateway,
    @Inject(NOTIFICADOR)
    notificadores: Notificador[],
  ) {
    this.notificadoresPorCanal = new Map(
      notificadores.map((n) => [n.canal, n]),
    );
    if (this.notificadoresPorCanal.size !== notificadores.length) {
      const canais = notificadores.map((n) => n.canal);
      throw new Error(
        `Notificadores duplicados para o mesmo canal: ${canais.join(', ')}`,
      );
    }
  }

  async execute(input: EnviarNotificacaoInput): Promise<Notificacao[]> {
    const canais = input.canal
      ? [input.canal]
      : [...this.notificadoresPorCanal.keys()];
    const resultado: Notificacao[] = [];
    for (const canal of canais) {
      const n = await this.enviarPorCanal(input, canal);
      if (n) resultado.push(n);
    }
    return resultado;
  }

  private async enviarPorCanal(
    input: EnviarNotificacaoInput,
    canal: CanalNotificacao,
  ): Promise<Notificacao | null> {
    const destinatario =
      canal === CanalNotificacao.EMAIL
        ? input.destinatario
        : (input.destinatario ?? input.clienteId);
    if (!destinatario) {
      this.logger.warn(
        `Cliente ${input.clienteId} sem email; notificacao tipo=${input.tipo} da OS ${input.numeroOS ?? input.ordemDeServicoId ?? '-'} nao sera enviada por ${canal}`,
      );
      return null;
    }

    const reservada = await this.gateway.reservar(
      Notificacao.create({
        clienteId: input.clienteId,
        ordemDeServicoId: input.ordemDeServicoId,
        numeroOS: input.numeroOS,
        eventoId: input.eventoId,
        linkPagamento: input.linkPagamento,
        tipo: input.tipo,
        canal,
        destinatario,
        assunto: input.assunto,
        mensagem: input.mensagem,
      }),
    );
    if (!reservada) {
      this.logger.warn(
        `Ja notificado: tipo=${input.tipo} canal=${canal} eventoId=${input.eventoId} OS=${input.numeroOS ?? '-'}; nao reenvia`,
      );
      return null;
    }

    const notificador = this.notificadoresPorCanal.get(canal);
    if (!notificador) {
      reservada.marcarComoFalha(
        `Nenhum notificador registrado para o canal ${canal}`,
      );
      return this.gateway.atualizarResultado(reservada);
    }

    try {
      await notificador.enviar({
        destinatario,
        assunto: input.assunto,
        corpo: input.mensagem,
        contexto: {
          ordemId: input.ordemDeServicoId,
          clienteId: input.clienteId,
          numeroOS: input.numeroOS,
          linkPagamento: input.linkPagamento,
          eventoId: input.eventoId,
          statusAnterior: input.statusAnterior,
          statusAtual: input.statusAtual,
          timestamp: input.timestamp,
          tipoNotificacao: input.tipo,
        },
      });
      reservada.marcarComoEnviada();
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Falha ao enviar notificacao tipo=${input.tipo} canal=${canal}: ${motivo}`,
      );
      reservada.marcarComoFalha(motivo);
    }

    return this.gateway.atualizarResultado(reservada);
  }
}
