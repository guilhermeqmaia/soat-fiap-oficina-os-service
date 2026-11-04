import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  CLIENTE_REPOSITORY,
  ClienteRepository,
} from '../../../cliente/domain/cliente.repository';
import { OrcamentoProntoEvent } from '../../../shared/domain/events/orcamento-pronto.event';
import { OsFinalizadaEvent } from '../../../shared/domain/events/os-finalizada.event';
import { OsStatusAlteradoEvent } from '../../../ordem-de-servico/domain/events/os-status-alterado.event';
import { StatusOS } from '../../../ordem-de-servico/domain/value-objects/status-os.vo';
import { CanalNotificacao } from '../../domain/value-objects/canal-notificacao.vo';
import { TipoNotificacao } from '../../domain/value-objects/tipo-notificacao.vo';
import { EnviarNotificacaoUseCase } from '../use-cases/enviar-notificacao.use-case';
import { PUBLIC_BASE_URL } from '../ports/public-base-url';

/**
 * Transicoes que ja disparam uma notificacao dedicada e mais rica
 * (OrcamentoProntoEvent / OsFinalizadaEvent). A notificacao generica de
 * mudanca de status e suprimida para esses status para nao notificar o
 * cliente duas vezes pela mesma transicao.
 */
const STATUS_COM_NOTIFICACAO_DEDICADA: ReadonlySet<StatusOS> = new Set([
  StatusOS.AGUARDANDO_APROVACAO,
  StatusOS.FINALIZADA,
]);

@Injectable()
export class OrdemDeServicoNotificacaoListener {
  private readonly logger = new Logger(OrdemDeServicoNotificacaoListener.name);
  private readonly baseUrl: string;

  constructor(
    private readonly enviarNotificacao: EnviarNotificacaoUseCase,
    @Inject(CLIENTE_REPOSITORY)
    private readonly clienteRepository: ClienteRepository,
    @Inject(PUBLIC_BASE_URL)
    baseUrl: string,
  ) {
    this.baseUrl = baseUrl;
  }

  @OnEvent(OrcamentoProntoEvent.EVENT_NAME)
  async onOrcamentoPronto(event: OrcamentoProntoEvent): Promise<void> {
    try {
      const cliente = await this.clienteRepository.findById(event.clienteId);
      if (!cliente?.email) {
        this.logger.warn(
          `Cliente ${event.clienteId} sem email; notificacao de orcamento da OS ${event.numero} nao sera enviada`,
        );
        return;
      }

      const valorFormatado = event.valorTotal.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      });

      const mensagem =
        `Ola ${cliente.nome},\n\n` +
        `O orcamento da sua Ordem de Servico ${event.numero} esta pronto.\n\n` +
        `Diagnostico: ${event.diagnostico}\n` +
        `Valor total estimado: ${valorFormatado}\n\n` +
        // Fase 4: aprovacao/rejeicao e pagamento acontecem no Billing; o link de
        // pagamento chega na notificacao de `billing.cobranca-criada`, depois do servico executado (US-F4-12).
        `Acesse o portal do cliente para aprovar ou rejeitar o orcamento.\n`;

      await this.enviarNotificacao.execute({
        clienteId: event.clienteId,
        ordemDeServicoId: event.ordemDeServicoId,
        tipo: TipoNotificacao.ORCAMENTO_PRONTO,
        canal: CanalNotificacao.EMAIL,
        destinatario: cliente.email,
        assunto: `Orcamento da OS ${event.numero} pronto para aprovacao`,
        mensagem,
      });
    } catch (err) {
      this.logger.error(
        `Erro ao processar OrcamentoProntoEvent para OS ${event.numero}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(OsFinalizadaEvent.EVENT_NAME)
  async onOsFinalizada(event: OsFinalizadaEvent): Promise<void> {
    try {
      const cliente = await this.clienteRepository.findById(event.clienteId);
      if (!cliente?.email) {
        this.logger.warn(
          `Cliente ${event.clienteId} sem email; notificacao de finalizacao da OS ${event.numero} nao sera enviada`,
        );
        return;
      }

      const acompanharUrl = `${this.baseUrl}/ordens-servico/numero/${event.numero}/status`;

      const mensagem =
        `Ola ${cliente.nome},\n\n` +
        `Sua Ordem de Servico ${event.numero} foi finalizada e o veiculo esta pronto para retirada.\n\n` +
        `Para acompanhar a OS: GET ${acompanharUrl}\n`;

      await this.enviarNotificacao.execute({
        clienteId: event.clienteId,
        ordemDeServicoId: event.ordemDeServicoId,
        tipo: TipoNotificacao.OS_FINALIZADA,
        canal: CanalNotificacao.EMAIL,
        destinatario: cliente.email,
        assunto: `OS ${event.numero} finalizada - veiculo pronto para retirada`,
        mensagem,
      });
    } catch (err) {
      this.logger.error(
        `Erro ao processar OsFinalizadaEvent para OS ${event.numero}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(OsStatusAlteradoEvent.EVENT_NAME)
  async onOsStatusAlterado(event: OsStatusAlteradoEvent): Promise<void> {
    if (STATUS_COM_NOTIFICACAO_DEDICADA.has(event.statusAtual)) {
      return;
    }

    try {
      const cliente = await this.clienteRepository.findById(event.clienteId);
      const destinatario = cliente?.email ?? event.clienteId;
      const mensagem =
        `Status da Ordem de Servico ${event.numero} alterado.\n\n` +
        `Status anterior: ${event.statusAnterior}\n` +
        `Status atual: ${event.statusAtual}\n`;

      await this.enviarNotificacao.execute({
        clienteId: event.clienteId,
        ordemDeServicoId: event.ordemDeServicoId,
        tipo: TipoNotificacao.STATUS_OS_ALTERADO,
        canal: CanalNotificacao.EMAIL,
        destinatario,
        assunto: `Status da OS ${event.numero}: ${event.statusAtual}`,
        mensagem,
        statusAnterior: event.statusAnterior,
        statusAtual: event.statusAtual,
        timestamp: event.timestamp,
      });
    } catch (err) {
      this.logger.error(
        `Erro ao processar OsStatusAlteradoEvent para OS ${event.numero}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
