import { createHmac } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CanalNotificacao } from '../domain/value-objects/canal-notificacao.vo';
import { integracaoResultados } from '../../observabilidade/metrics.registry';
import {
  MensagemNotificacao,
  Notificador,
} from '../application/ports/notificador.port';
import { getCorrelationId } from '@guilhermeqmaia/oficina-kit/logging';

/**
 * Corpo do webhook (US-F4-12): `{ numeroOS, tipo, mensagem, linkPagamento? }`
 * assinado com HMAC-SHA256 (`X-Signature: sha256=<hex>` sobre o corpo exato).
 * Os campos da Fase 2 (`ordemId`, `clienteId`, `statusAnterior`, `statusAtual`,
 * `timestamp`, `tipoNotificacao`) continuam no corpo para nao quebrar quem ja consome.
 */
export interface WebhookPayload {
  numeroOS: string | null;
  tipo: string | null;
  mensagem: string;
  linkPagamento?: string;
  ordemId: string | null;
  clienteId: string | null;
  statusAnterior: string | null;
  statusAtual: string | null;
  timestamp: string;
  tipoNotificacao: string | null;
}

@Injectable()
export class WebhookNotificador implements Notificador {
  readonly canal = CanalNotificacao.WEBHOOK;
  private readonly logger = new Logger(WebhookNotificador.name);
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.url = this.config.get<string>('NOTIFICATION_WEBHOOK_URL', '').trim();
    this.secret = this.config.get<string>('NOTIFICATION_WEBHOOK_SECRET', '');
    this.timeoutMs = this.parseTimeout(
      this.config.get<string>('NOTIFICATION_WEBHOOK_TIMEOUT_MS'),
    );
  }

  async enviar(mensagem: MensagemNotificacao): Promise<void> {
    if (!this.url) {
      throw new Error('NOTIFICATION_WEBHOOK_URL nao configurada');
    }

    const body = JSON.stringify(this.toPayload(mensagem));
    const signature = createHmac('sha256', this.secret)
      .update(body)
      .digest('hex');

    const correlationId = getCorrelationId();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Signature': `sha256=${signature}`,
      ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.post(body, headers);
        // Sinal de integracao para os dashboards/alertas (US-F3-10/11).
        integracaoResultados.inc({ integracao: 'webhook-notificacao', resultado: 'sucesso' });
        return;
      } catch (err) {
        lastError = err;
        const motivo = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Falha ao publicar webhook de notificacao (tentativa ${attempt}/2): ${motivo}`,
        );

        if (attempt < 2) {
          await this.sleep(250);
        }
      }
    }

    integracaoResultados.inc({ integracao: 'webhook-notificacao', resultado: 'falha' });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private toPayload(mensagem: MensagemNotificacao): WebhookPayload {
    const timestamp = mensagem.contexto?.timestamp
      ? new Date(mensagem.contexto.timestamp).toISOString()
      : new Date().toISOString();

    const tipo = mensagem.contexto?.tipoNotificacao ?? null;
    return {
      numeroOS: mensagem.contexto?.numeroOS ?? null,
      tipo,
      mensagem: mensagem.corpo,
      ...(mensagem.contexto?.linkPagamento
        ? { linkPagamento: mensagem.contexto.linkPagamento }
        : {}),
      ordemId: mensagem.contexto?.ordemId ?? null,
      clienteId: mensagem.contexto?.clienteId ?? null,
      statusAnterior: mensagem.contexto?.statusAnterior ?? null,
      statusAtual: mensagem.contexto?.statusAtual ?? null,
      timestamp,
      tipoNotificacao: tipo,
    };
  }

  private async post(
    body: string,
    headers: Record<string, string>,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook retornou status ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Timeout ao publicar webhook apos ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseTimeout(value?: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
