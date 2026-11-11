import 'reflect-metadata';
import { ClienteHttpInterno, criarEnvelopeHttp, EnvelopeHttp, HttpInternoError } from '@guilhermeqmaia/oficina-kit/http';
import { validarEnvelopeCallback } from './contratos';
import { traceIdDe } from './log';
import type { ServidorStub } from './servidor';

/**
 * Callbacks para o OS Service (`POST /ordens-servico/{numero}/eventos`) pelo
 * cliente HTTP do kit — o mesmo que os servicos reais usam: JWT `SERVICO`
 * com `sub` = este servico, `x-correlation-id` = numero da OS, timeout e 3
 * tentativas com backoff em 5xx/rede. Regras do contrato que o kit nao faz e
 * ficam aqui: `409` do OS -> reler e repetir; `traceparent` recebido na acao
 * e repassado (o kit 0.3.0 so gera `traceparent` com APM ativo).
 */
export interface ResultadoCallback {
  id: string;
  type: string;
  status: number;
  body: unknown;
  /** Tentativas extras por causa de 409 (as de 5xx sao internas ao kit). */
  repeticoes409: number;
}

type Producer = 'billing-service' | 'execucao-service';

export class EmissorCallbacks {
  private readonly http: ClienteHttpInterno;
  private readonly ultimos = new Map<string, EnvelopeHttp>();
  private readonly osUrl: string;

  constructor(
    private readonly producer: Producer,
    private readonly servidor: ServidorStub,
  ) {
    this.osUrl = (process.env.OS_SERVICE_URL ?? 'http://os-service:3000').replace(/\/+$/, '');
    this.http = new ClienteHttpInterno({
      servico: producer,
      jwtSecret: process.env.JWT_SECRET ?? '',
      timeoutMs: Number(process.env.HTTP_INTERNO_TIMEOUT_MS ?? 5000),
      tentativas: Number(process.env.HTTP_INTERNO_TENTATIVAS ?? 3),
    });
  }

  async enviar(numeroOS: string, type: string, data: Record<string, unknown>, traceparent?: string): Promise<ResultadoCallback> {
    const envelope = criarEnvelopeHttp({ type, producer: this.producer, data: { numeroOS, ...data } });
    return this.postar(numeroOS, envelope, traceparent);
  }

  /** Reenvia o ultimo envelope desta OS com o MESMO `id` (entrega duplicada). */
  async reenviarUltimo(numeroOS: string, traceparent?: string): Promise<ResultadoCallback | undefined> {
    const envelope = this.ultimos.get(numeroOS);
    return envelope ? this.postar(numeroOS, envelope, traceparent) : undefined;
  }

  private async postar(numeroOS: string, envelope: EnvelopeHttp, traceparent?: string): Promise<ResultadoCallback> {
    this.ultimos.set(numeroOS, envelope);
    const rota = 'POST /ordens-servico/{numero}/eventos';
    const problema = validarEnvelopeCallback(envelope);
    if (problema) this.servidor.registrarViolacao({ tipo: 'callback', rota, numeroOS, detalhe: problema, corpo: envelope });

    const url = `${this.osUrl}/ordens-servico/${encodeURIComponent(numeroOS)}/eventos`;
    const headers: Record<string, string> = traceparent ? { traceparent } : {};
    const log = { correlation_id: numeroOS, trace_id: traceIdDe(traceparent), rota, type: envelope.type, id: envelope.id };
    let repeticoes409 = 0;
    for (;;) {
      try {
        const res = await this.http.post(url, envelope, { correlationId: numeroOS, headers });
        this.servidor.log.info('callback entregue', { ...log, status: res.status, resposta: res.body });
        return { id: envelope.id, type: envelope.type, status: res.status, body: res.body, repeticoes409 };
      } catch (e) {
        if (!(e instanceof HttpInternoError)) throw e;
        if (e.status === 409 && repeticoes409 < 3) {
          repeticoes409++;
          this.servidor.log.warn('callback em conflito (409) — relendo e repetindo', { ...log, tentativa: repeticoes409 + 1 });
          await new Promise((r) => setTimeout(r, 200 * repeticoes409));
          continue;
        }
        // Contrato: falha apos as tentativas -> log de erro; o estado fica no participante.
        this.servidor.log.error('callback falhou', { ...log, status: e.status, tentativas: e.tentativas, erro: e.message });
        return { id: envelope.id, type: envelope.type, status: e.status ?? 0, body: e.body ?? { erro: e.message }, repeticoes409 };
      }
    }
  }
}
