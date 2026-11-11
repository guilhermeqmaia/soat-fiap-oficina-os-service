import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  CLIENTE_REPOSITORY,
  ClienteRepository,
} from '../../../cliente/domain/cliente.repository';
import {
  MarcoOrdemDeServicoEvent,
  TipoMarcoOS,
} from '../../../shared/domain/events/marco-ordem-de-servico.event';
import { OsStatusAlteradoEvent } from '../../../ordem-de-servico/domain/events/os-status-alterado.event';
import { StatusOS } from '../../../ordem-de-servico/domain/value-objects/status-os.vo';
import { TipoNotificacao } from '../../domain/value-objects/tipo-notificacao.vo';
import { EnviarNotificacaoUseCase } from '../use-cases/enviar-notificacao.use-case';
import { PUBLIC_BASE_URL } from '../ports/public-base-url';

/**
 * Status que ja tem notificacao dedicada (marco da OS, US-F4-12). A
 * notificacao generica STATUS_OS_ALTERADO e suprimida para eles, para nao
 * notificar o cliente duas vezes pelo mesmo momento da OS:
 * - AGUARDANDO_APROVACAO -> ORCAMENTO_PRONTO (`billing.orcamento-gerado`)
 * - AGUARDANDO_PAGAMENTO -> PAGAMENTO_PENDENTE com link (`billing.cobranca-criada`)
 * - FINALIZADA           -> OS_FINALIZADA
 * - CANCELADA            -> OS_CANCELADA
 * EM_DIAGNOSTICO, EM_EXECUCAO e ENTREGUE continuam com a generica.
 */
export const STATUS_COM_NOTIFICACAO_DEDICADA: ReadonlySet<StatusOS> = new Set([
  StatusOS.AGUARDANDO_APROVACAO,
  StatusOS.AGUARDANDO_PAGAMENTO,
  StatusOS.FINALIZADA,
  StatusOS.CANCELADA,
]);

interface ConteudoNotificacao {
  tipo: TipoNotificacao;
  assunto: string;
  mensagem: string;
}

const brl = (valor: number) =>
  valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

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

  /**
   * Marco da OS (US-F4-12): publicado pelo orquestrador/transicoes SO depois do
   * commit e so quando a saga aceitou o fato. A deduplicacao final e o indice
   * unico (eventoId, tipo, canal) na tabela `notificacao`.
   */
  @OnEvent(MarcoOrdemDeServicoEvent.EVENT_NAME)
  async onMarco(event: MarcoOrdemDeServicoEvent): Promise<void> {
    try {
      const cliente = await this.clienteRepository.findById(event.clienteId);
      if (!cliente) {
        this.logger.warn(
          `Cliente ${event.clienteId} nao encontrado; notificacao ${event.type} da OS ${event.numeroOS} nao sera enviada`,
        );
        return;
      }
      const conteudo = this.conteudo(event, cliente.nome);
      await this.enviarNotificacao.execute({
        clienteId: event.clienteId,
        ordemDeServicoId: event.ordemDeServicoId,
        numeroOS: event.numeroOS,
        eventoId: event.eventoId,
        linkPagamento: event.dados.linkPagamento,
        tipo: conteudo.tipo,
        destinatario: cliente.email ?? null,
        assunto: conteudo.assunto,
        mensagem: conteudo.mensagem,
      });
    } catch (err) {
      this.logger.error(
        `Erro ao processar marco ${event.type} da OS ${event.numeroOS}`,
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
      const mensagem =
        `Status da Ordem de Servico ${event.numero} alterado.\n\n` +
        `Status anterior: ${event.statusAnterior}\n` +
        `Status atual: ${event.statusAtual}\n`;

      await this.enviarNotificacao.execute({
        clienteId: event.clienteId,
        ordemDeServicoId: event.ordemDeServicoId,
        numeroOS: event.numero,
        // A maquina de estados da OS nao volta a um status: (OS, status) identifica o fato.
        eventoId: `os.status:${event.numero}:${event.statusAtual}`,
        tipo: TipoNotificacao.STATUS_OS_ALTERADO,
        // Fase 2: sem e-mail o destinatario registrado e o id do cliente.
        destinatario: cliente?.email ?? event.clienteId,
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

  /** Tipo, assunto e corpo (pt-BR) de cada marco. */
  private conteudo(
    event: MarcoOrdemDeServicoEvent,
    nome: string,
  ): ConteudoNotificacao {
    const n = event.numeroOS;
    const ola = `Ola ${nome},\n\n`;
    const d = event.dados;
    const conteudos: Record<TipoMarcoOS, () => ConteudoNotificacao> = {
      'billing.orcamento-gerado': () => ({
        tipo: TipoNotificacao.ORCAMENTO_PRONTO,
        assunto: `Orcamento da OS ${n} pronto para aprovacao`,
        mensagem:
          ola +
          `O orcamento da sua Ordem de Servico ${n} esta pronto.\n\n` +
          (d.diagnostico ? `Diagnostico: ${d.diagnostico}\n` : '') +
          (d.total !== undefined ? `Valor total estimado: ${brl(d.total)}\n` : '') +
          `\nAcesse o portal do cliente para aprovar ou rejeitar o orcamento.\n`,
      }),
      'billing.orcamento-aprovado': () => ({
        tipo: TipoNotificacao.ORCAMENTO_APROVADO,
        assunto: `Orcamento da OS ${n} aprovado`,
        // Sem link: a cobranca so e criada depois do servico executado (ADR-0012).
        mensagem:
          ola +
          `Recebemos a aprovacao do orcamento da sua Ordem de Servico ${n}.\n\n` +
          `O servico sera iniciado em breve. Quando ele for concluido, voce recebera o link de pagamento.\n`,
      }),
      'billing.cobranca-criada': () => ({
        tipo: TipoNotificacao.PAGAMENTO_PENDENTE,
        assunto: `OS ${n} concluida - pague para retirar o veiculo`,
        mensagem:
          ola +
          `O servico da sua Ordem de Servico ${n} foi concluido.\n\n` +
          (d.valor ? `Valor a pagar: ${brl(Number(d.valor))}\n` : '') +
          (d.linkPagamento
            ? `Para retirar o veiculo, realize o pagamento: ${d.linkPagamento}\n`
            : `Para retirar o veiculo, realize o pagamento pelo portal do cliente.\n`),
      }),
      'billing.pagamento-aprovado': () => ({
        tipo: TipoNotificacao.PAGAMENTO_APROVADO,
        assunto: `Pagamento da OS ${n} confirmado`,
        mensagem:
          ola +
          `Confirmamos o pagamento da sua Ordem de Servico ${n}` +
          (d.valor ? ` (${brl(Number(d.valor))})` : '') +
          `.\n\nObrigado!\n`,
      }),
      'billing.pagamento-recusado': () => ({
        tipo: TipoNotificacao.PAGAMENTO_RECUSADO,
        assunto: `Pagamento da OS ${n} recusado`,
        mensagem:
          ola +
          `O pagamento da sua Ordem de Servico ${n} foi recusado` +
          (d.motivo ? ` (motivo: ${d.motivo})` : '') +
          `.\n\n` +
          (d.linkPagamento
            ? `Tente novamente pelo link: ${d.linkPagamento}\n`
            : `Tente novamente pelo link de pagamento recebido ou entre em contato com a oficina.\n`) +
          `O veiculo fica disponivel para retirada assim que o pagamento for confirmado.\n`,
      }),
      'os.finalizada': () => ({
        tipo: TipoNotificacao.OS_FINALIZADA,
        assunto: `OS ${n} finalizada - veiculo pronto para retirada`,
        mensagem:
          ola +
          `Sua Ordem de Servico ${n} foi finalizada e o veiculo esta pronto para retirada.\n\n` +
          `Para acompanhar a OS: GET ${this.baseUrl}/ordens-servico/numero/${n}/status\n`,
      }),
      'os.cancelada': () => ({
        tipo: TipoNotificacao.OS_CANCELADA,
        assunto: `OS ${n} cancelada`,
        mensagem:
          ola +
          `Sua Ordem de Servico ${n} foi cancelada` +
          (d.motivo ? ` (motivo: ${d.motivo})` : '') +
          `.\n\nEm caso de duvidas, entre em contato com a oficina.\n`,
      }),
    };
    return conteudos[event.type]();
  }
}
