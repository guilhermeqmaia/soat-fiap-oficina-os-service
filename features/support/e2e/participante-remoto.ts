import type { ControleParticipante } from '../contexto';
import { ClienteHttpTeste } from '../http-client';
import type { ChamadaRecebida, RespostaStub } from '../stub-http';

/**
 * Billing/Execucao do compose (e2e/stubs) controlados por HTTP. Implementa a
 * mesma interface do `StubHttp` em memoria, entao os steps de participante
 * ("o serviço X recebeu N chamadas em ...", "está fora do ar em ...") rodam
 * iguais nos dois perfis. Rotas `/__stub/*` so existem nos stubs.
 */
export interface Violacao {
  tipo: string;
  rota: string;
  numeroOS?: string;
  detalhe: string;
}

export class ParticipanteRemoto implements ControleParticipante {
  readonly http: ClienteHttpTeste;

  constructor(
    readonly nome: 'Execução' | 'Billing',
    baseUrl: string,
  ) {
    this.http = new ClienteHttpTeste(baseUrl);
  }

  /** `true` se for o stub (tem `/__stub`); `false` com a imagem real. */
  async ehStub(): Promise<boolean> {
    try {
      return (await this.http.get('/__stub/cenario')).status === 200;
    } catch {
      return false;
    }
  }

  async chamadasEm(rota: string): Promise<ChamadaRecebida[]> {
    const res = await this.http.get(`/__stub/chamadas?rota=${encodeURIComponent(rota)}`);
    this.exigir(res.status, 'GET /__stub/chamadas');
    return res.body;
  }

  /** 5xx -> falha em todas as proximas chamadas da rota; 409 -> recusa de negocio. */
  async responder(rota: string, resposta: RespostaStub): Promise<void> {
    if (resposta.status >= 500) {
      await this.cenario({ falhar5xx: 1_000_000, statusFalha: resposta.status, rota });
    } else if (resposta.status === 409) {
      await this.cenario({ recusar: { rota, motivo: (resposta.body as { motivo?: string })?.motivo ?? 'recusado pelo cenario' } });
    } else {
      throw new Error(`o stub remoto so simula 5xx e 409 (pedido: ${resposta.status})`);
    }
  }

  async falharProximas(quantidade: number, rota: string): Promise<void> {
    await this.cenario({ falhar5xx: quantidade, statusFalha: 503, rota });
  }

  async restaurar(): Promise<void> {
    this.exigir((await this.http.delete('/__stub/cenario')).status, 'DELETE /__stub/cenario');
  }

  async cenario(parcial: Record<string, unknown>): Promise<void> {
    this.exigir((await this.http.post('/__stub/cenario', parcial)).status, 'POST /__stub/cenario');
  }

  /** Estado do participante para a OS (`GET /__stub/ordens|orcamentos/{n}`). */
  async estado(numeroOS: string): Promise<{ status: string; [k: string]: any } | undefined> {
    const recurso = this.nome === 'Execução' ? 'ordens' : 'orcamentos';
    const res = await this.http.get(`/__stub/${recurso}/${encodeURIComponent(numeroOS)}`);
    return res.status === 200 ? res.body : undefined;
  }

  async violacoes(): Promise<Violacao[]> {
    const res = await this.http.get('/__stub/violacoes');
    return res.status === 200 ? res.body : [];
  }

  private exigir(status: number, oQue: string): void {
    if (status !== 200) throw new Error(`${this.nome}: ${oQue} respondeu ${status} (a imagem real nao tem /__stub — rode sem os cenarios @stub)`);
  }
}
