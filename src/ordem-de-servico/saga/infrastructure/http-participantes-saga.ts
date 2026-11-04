import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClienteHttpInterno, HttpInternoError } from '@guilhermeqmaia/oficina-kit/http';
import { ComandoSaga, TipoComando } from '../domain/saga-os.entity';
import { ParticipantesSagaGateway, ResultadoComando } from '../application/ports/participantes-saga.gateway';
import { integracaoResultados } from '../../../observabilidade/metrics.registry';

/** Bases internas dos participantes (DNS do cluster; `localhost` em dev). */
export interface UrlsParticipantes {
  readonly execucao: string;
  readonly billing: string;
}
export const URLS_PARTICIPANTES = Symbol('URLS_PARTICIPANTES');

interface Rota {
  participante: 'execucao-service' | 'billing-service';
  metodo: 'POST' | 'DELETE';
  url: string;
  body?: unknown;
  /** Evento da saga equivalente a resposta 2xx. */
  sucesso: string;
  /** Evento de falha de negocio equivalente a um 409 `{ motivo }` (quando existe). */
  recusa?: string;
  /** 409 significa "ja existe" e o corpo e o recurso existente: trata como sucesso (idempotencia). */
  conflitoEhSucesso?: boolean;
}

/**
 * Comando da saga -> endpoint HTTP do participante (tabela de
 * `docs/contratos/http-interno.md`). A resposta sincrona vira o evento da saga.
 */
export function rotaDoComando(comando: ComandoSaga, urls: UrlsParticipantes): Rota {
  const numeroOS = String(comando.data.numeroOS);
  const n = encodeURIComponent(numeroOS);
  const motivo = { motivo: String(comando.data.motivo ?? 'OS cancelada (compensacao da saga)') };
  const rotas: Record<TipoComando, () => Rota> = {
    'execucao.enfileirar': () => ({
      participante: 'execucao-service',
      metodo: 'POST',
      url: `${urls.execucao}/execucao/ordens`,
      body: { numeroOS, veiculoId: comando.data.veiculoId, descricaoProblema: comando.data.descricaoProblema },
      sucesso: 'execucao.enfileirada',
      recusa: 'execucao.recusada',
    }),
    'execucao.iniciar': () => ({
      participante: 'execucao-service',
      metodo: 'POST',
      url: `${urls.execucao}/execucao/ordens/${n}/iniciar`,
      sucesso: 'execucao.iniciada',
      recusa: 'execucao.recusada',
    }),
    'execucao.liberar-reservas': () => ({
      participante: 'execucao-service',
      metodo: 'DELETE',
      url: `${urls.execucao}/execucao/ordens/${n}`,
      body: motivo,
      sucesso: 'execucao.reservas-liberadas',
    }),
    'billing.gerar-orcamento': () => ({
      participante: 'billing-service',
      metodo: 'POST',
      url: `${urls.billing}/orcamentos`,
      body: { numeroOS, clienteId: comando.data.clienteId, itens: comando.data.itens },
      sucesso: 'billing.orcamento-gerado',
      conflitoEhSucesso: true,
    }),
    'billing.cobrar': () => ({
      participante: 'billing-service',
      metodo: 'POST',
      url: `${urls.billing}/orcamentos/${n}/cobrar`,
      sucesso: 'billing.cobranca-criada',
    }),
    'billing.cancelar-orcamento': () => ({
      participante: 'billing-service',
      metodo: 'DELETE',
      url: `${urls.billing}/orcamentos/${n}`,
      body: motivo,
      sucesso: 'billing.orcamento-cancelado',
    }),
  };
  return rotas[comando.type]();
}

/**
 * Participantes da saga por HTTP (RFC-0008) com o `ClienteHttpInterno` do kit:
 * JWT de servico, `x-correlation-id` = numero da OS, timeout e 3 tentativas
 * para 5xx/timeout/rede. 201/200 = evento de sucesso (corpo = `data`);
 * 409 `{ motivo }` = evento de recusa; outros 4xx ou tentativas esgotadas =
 * nao entregue (a saga fica no passo).
 */
@Injectable()
export class HttpParticipantesSaga implements ParticipantesSagaGateway {
  private readonly logger = new Logger(HttpParticipantesSaga.name);

  constructor(
    private readonly http: ClienteHttpInterno,
    @Inject(URLS_PARTICIPANTES) private readonly urls: UrlsParticipantes,
  ) {}

  async executar(comando: ComandoSaga): Promise<ResultadoComando> {
    const rota = rotaDoComando(comando, this.urls);
    const numeroOS = String(comando.data.numeroOS);
    const opcoes = { correlationId: numeroOS };
    try {
      const resposta =
        rota.metodo === 'POST'
          ? await this.http.post(rota.url, rota.body, opcoes)
          : await this.http.delete(rota.url, rota.body, opcoes);
      integracaoResultados.inc({ integracao: rota.participante, resultado: 'sucesso' });
      this.logger.log({ msg: 'comando executado', numeroOS, comando: comando.type, status: resposta.status, evento: rota.sucesso });
      return { entregue: true, evento: { type: rota.sucesso, data: { ...objeto(resposta.body), numeroOS } } };
    } catch (e) {
      if (e instanceof HttpInternoError && e.status === 409) {
        const corpo = objeto(e.body);
        if (rota.recusa) {
          integracaoResultados.inc({ integracao: rota.participante, resultado: 'recusado' });
          this.logger.warn({ msg: 'comando recusado pelo participante', numeroOS, comando: comando.type, motivo: corpo.motivo, evento: rota.recusa });
          return { entregue: true, evento: { type: rota.recusa, data: { numeroOS, motivo: String(corpo.motivo ?? 'recusado pelo participante') } } };
        }
        if (rota.conflitoEhSucesso) {
          integracaoResultados.inc({ integracao: rota.participante, resultado: 'sucesso' });
          this.logger.warn({ msg: 'recurso ja existia no participante — tratado como sucesso', numeroOS, comando: comando.type, evento: rota.sucesso });
          return { entregue: true, evento: { type: rota.sucesso, data: { ...corpo, numeroOS } } };
        }
      }
      integracaoResultados.inc({ integracao: rota.participante, resultado: 'falha' });
      const status = e instanceof HttpInternoError ? e.status : undefined;
      const tentativas = e instanceof HttpInternoError ? e.tentativas : undefined;
      this.logger.error({ msg: 'comando nao entregue', numeroOS, comando: comando.type, metodo: rota.metodo, url: rota.url, status, tentativas, erro: (e as Error).message });
      return { entregue: false, erro: (e as Error).message, status };
    }
  }
}

function objeto(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Record<string, unknown>) : {};
}
