import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClienteHttpInterno, HttpInternoError } from '@guilhermeqmaia/oficina-kit/http';
import { ComandoSaga, TipoComando } from '../domain/saga-os.entity';
import { ParticipantesSagaGateway, ResultadoComando } from '../application/ports/participantes-saga.gateway';
import {
  DestinoHttpInterno,
  ORIGEM_HTTP_INTERNO,
  ResultadoHttpInterno,
  httpInternoDuracao,
  httpInternoTotal,
  integracaoResultados,
} from '../../../observabilidade/metrics.registry';
import { camposDeRastreio, comCorrelacaoDaOS } from '../../../observabilidade/rastreio';

/** Bases internas dos participantes (DNS do cluster; `localhost` em dev). */
export interface UrlsParticipantes {
  readonly execucao: string;
  readonly billing: string;
}
export const URLS_PARTICIPANTES = Symbol('URLS_PARTICIPANTES');

interface Rota {
  participante: DestinoHttpInterno;
  metodo: 'POST' | 'DELETE';
  url: string;
  /** Template da rota (label `rota` das metricas e campo `rota` dos logs) — sem o numero da OS. */
  rota: string;
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
      rota: 'POST /execucao/ordens',
      body: { numeroOS, veiculoId: comando.data.veiculoId, descricaoProblema: comando.data.descricaoProblema },
      sucesso: 'execucao.enfileirada',
      recusa: 'execucao.recusada',
    }),
    'execucao.iniciar': () => ({
      participante: 'execucao-service',
      metodo: 'POST',
      url: `${urls.execucao}/execucao/ordens/${n}/iniciar`,
      rota: 'POST /execucao/ordens/{numero}/iniciar',
      sucesso: 'execucao.iniciada',
      recusa: 'execucao.recusada',
    }),
    'execucao.liberar-reservas': () => ({
      participante: 'execucao-service',
      metodo: 'DELETE',
      url: `${urls.execucao}/execucao/ordens/${n}`,
      rota: 'DELETE /execucao/ordens/{numero}',
      body: motivo,
      sucesso: 'execucao.reservas-liberadas',
    }),
    'billing.gerar-orcamento': () => ({
      participante: 'billing-service',
      metodo: 'POST',
      url: `${urls.billing}/orcamentos`,
      rota: 'POST /orcamentos',
      body: { numeroOS, clienteId: comando.data.clienteId, itens: comando.data.itens },
      sucesso: 'billing.orcamento-gerado',
      conflitoEhSucesso: true,
    }),
    'billing.cobrar': () => ({
      participante: 'billing-service',
      metodo: 'POST',
      url: `${urls.billing}/orcamentos/${n}/cobrar`,
      rota: 'POST /orcamentos/{numero}/cobrar',
      sucesso: 'billing.cobranca-criada',
    }),
    'billing.cancelar-orcamento': () => ({
      participante: 'billing-service',
      metodo: 'DELETE',
      url: `${urls.billing}/orcamentos/${n}`,
      rota: 'DELETE /orcamentos/{numero}',
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
 * nao entregue (a saga fica no passo e registra `chamada-falhou`).
 *
 * Observabilidade (US-F4-16): `oficina_http_interno_total{origem,destino,rota,resultado}`
 * e `oficina_http_interno_duracao_seconds{origem,destino,rota,status}` por chamada;
 * logs com `trace_id`, `correlation_id`, `servico`, `destino`, `rota` e `tentativa`.
 * `oficina_integracoes_total` (deprecated para os participantes) segue em paralelo.
 */
@Injectable()
export class HttpParticipantesSaga implements ParticipantesSagaGateway {
  private readonly logger = new Logger(HttpParticipantesSaga.name);

  constructor(
    private readonly http: ClienteHttpInterno,
    @Inject(URLS_PARTICIPANTES) private readonly urls: UrlsParticipantes,
  ) {}

  executar(comando: ComandoSaga): Promise<ResultadoComando> {
    const numeroOS = String(comando.data.numeroOS);
    // O numero da OS vira o correlationId do contexto durante a chamada: as linhas
    // de retentativa que o proprio kit loga saem com a OS e o trace.
    return comCorrelacaoDaOS(numeroOS, () => this.chamar(comando, numeroOS));
  }

  private async chamar(comando: ComandoSaga, numeroOS: string): Promise<ResultadoComando> {
    const rota = rotaDoComando(comando, this.urls);
    const opcoes = { correlationId: numeroOS };
    const log = (extra: Record<string, unknown>) =>
      camposDeRastreio(numeroOS, { destino: rota.participante, rota: rota.rota, comando: comando.type, ...extra });
    const inicio = process.hrtime.bigint();
    const medir = (status: number | undefined, resultado: ResultadoHttpInterno) => {
      const labels = { origem: ORIGEM_HTTP_INTERNO, destino: rota.participante, rota: rota.rota };
      httpInternoDuracao.observe({ ...labels, status: status !== undefined ? String(status) : 'sem_resposta' }, Number(process.hrtime.bigint() - inicio) / 1e9);
      httpInternoTotal.inc({ ...labels, resultado });
    };
    try {
      const resposta =
        rota.metodo === 'POST'
          ? await this.http.post(rota.url, rota.body, opcoes)
          : await this.http.delete(rota.url, rota.body, opcoes);
      medir(resposta.status, 'sucesso');
      integracaoResultados.inc({ integracao: rota.participante, resultado: 'sucesso' });
      this.logger.log({ msg: 'comando executado', ...log({ status: resposta.status, evento: rota.sucesso }) });
      return { entregue: true, evento: { type: rota.sucesso, data: { ...objeto(resposta.body), numeroOS } } };
    } catch (e) {
      const status = e instanceof HttpInternoError ? e.status : undefined;
      const tentativas = e instanceof HttpInternoError ? e.tentativas : undefined;
      if (e instanceof HttpInternoError && e.status === 409) {
        const corpo = objeto(e.body);
        if (rota.recusa) {
          medir(409, 'recusa');
          integracaoResultados.inc({ integracao: rota.participante, resultado: 'recusado' });
          this.logger.warn({ msg: 'comando recusado pelo participante', ...log({ status, tentativa: tentativas, motivo: corpo.motivo, evento: rota.recusa }) });
          return { entregue: true, evento: { type: rota.recusa, data: { numeroOS, motivo: String(corpo.motivo ?? 'recusado pelo participante') } } };
        }
        if (rota.conflitoEhSucesso) {
          medir(409, 'sucesso');
          integracaoResultados.inc({ integracao: rota.participante, resultado: 'sucesso' });
          this.logger.warn({ msg: 'recurso ja existia no participante — tratado como sucesso', ...log({ status, evento: rota.sucesso }) });
          return { entregue: true, evento: { type: rota.sucesso, data: { ...corpo, numeroOS } } };
        }
      }
      const resultado: ResultadoHttpInterno = e instanceof HttpInternoError && !e.transitoria ? (e.status === 409 ? 'recusa' : 'erro') : 'esgotado';
      medir(status, resultado);
      integracaoResultados.inc({ integracao: rota.participante, resultado: 'falha' });
      this.logger.error({
        msg: resultado === 'esgotado' ? 'comando nao entregue — tentativas esgotadas' : 'comando nao entregue — resposta sem retry',
        ...log({ metodo: rota.metodo, url: rota.url, status, tentativa: tentativas, resultado, erro: (e as Error).message }),
      });
      return { entregue: false, erro: (e as Error).message, status, tentativas, resultado };
    }
  }
}

function objeto(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Record<string, unknown>) : {};
}
