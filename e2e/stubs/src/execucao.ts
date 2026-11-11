import 'reflect-metadata';
import { conflito, naoEncontrada, respostaDaAcao } from './comum/acoes';
import { EmissorCallbacks } from './comum/callbacks';
import { criarLog } from './comum/log';
import { ServidorStub } from './comum/servidor';

/**
 * Execucao Service FALSO (porta 3002) — `docs/contratos/http-interno.md`,
 * secao "OS Service -> Execucao Service". Estado em memoria, idempotente por
 * numeroOS. Troque pela imagem real com `EXECUCAO_IMAGE` no compose.
 *
 * Contrato (role SERVICO):
 *   POST   /execucao/ordens                 201 { numeroOS, posicaoFila } | 409 { motivo } veiculo ja em execucao
 *   POST   /execucao/ordens/{n}/iniciar     200 { numeroOS }              | 409 { motivo } estoque insuficiente / sem diagnostico
 *   DELETE /execucao/ordens/{n}             200 { numeroOS }  (idempotente, 200 mesmo sem reservas)
 * Acoes do mecanico (MECANICO/ADMIN) que geram callback ao OS:
 *   POST   /execucao/ordens/{n}/diagnostico -> execucao.diagnostico-concluido
 *   POST   /execucao/ordens/{n}/finalizar   -> execucao.finalizada
 * Controle (so no stub): GET /__stub/ordens/{n}, POST /__stub/callbacks/{n}/reenviar
 */
type StatusOrdem = 'NA_FILA' | 'DIAGNOSTICADA' | 'EM_EXECUCAO' | 'FINALIZADA' | 'LIBERADA';

interface Item {
  tipo: 'SERVICO' | 'PRODUTO';
  referenciaId: string;
  nome: string;
  quantidade: number;
  precoUnitario: string;
  servicoId?: string;
}

interface OrdemExecucao {
  numeroOS: string;
  veiculoId: string;
  descricaoProblema: string;
  posicaoFila: number;
  status: StatusOrdem;
  itens: Item[];
  reservas: Item[];
  estoqueBaixado: boolean;
  motivoLiberacao?: string;
  historico: Array<{ em: string; evento: string }>;
}

const SERVICO = 'execucao-service';
const log = criarLog(SERVICO);
const servidor = new ServidorStub(SERVICO, log);
const callbacks = new EmissorCallbacks(SERVICO, servidor);
const ordens = new Map<string, OrdemExecucao>();

const ATIVAS: StatusOrdem[] = ['NA_FILA', 'DIAGNOSTICADA', 'EM_EXECUCAO'];
const marcar = (o: OrdemExecucao, evento: string) => o.historico.push({ em: new Date().toISOString(), evento });

servidor.adicionar(
  // ------------------------------------------------------------ contrato
  {
    metodo: 'POST',
    caminho: '/execucao/ordens',
    roles: ['SERVICO'],
    comando: 'execucao.enfileirar',
    handler: ({ body }) => {
      const existente = ordens.get(body.numeroOS);
      if (existente && existente.status !== 'LIBERADA') {
        return { status: 201, body: { numeroOS: existente.numeroOS, posicaoFila: existente.posicaoFila } };
      }
      const ocupado = [...ordens.values()].find((o) => o.veiculoId === body.veiculoId && o.numeroOS !== body.numeroOS && ATIVAS.includes(o.status));
      if (ocupado) return conflito(`veiculo ja em execucao na OS ${ocupado.numeroOS}`);
      const posicaoFila = [...ordens.values()].filter((o) => o.status === 'NA_FILA').length + 1;
      const ordem: OrdemExecucao = {
        numeroOS: body.numeroOS,
        veiculoId: body.veiculoId,
        descricaoProblema: body.descricaoProblema,
        posicaoFila,
        status: 'NA_FILA',
        itens: [],
        reservas: [],
        estoqueBaixado: false,
        historico: [],
      };
      marcar(ordem, 'enfileirada');
      ordens.set(ordem.numeroOS, ordem);
      return { status: 201, body: { numeroOS: ordem.numeroOS, posicaoFila } };
    },
  },
  {
    metodo: 'POST',
    caminho: '/execucao/ordens/{n}/iniciar',
    roles: ['SERVICO'],
    comando: 'execucao.iniciar',
    handler: ({ params }) => {
      const o = ordens.get(params.n);
      if (!o) return naoEncontrada(params.n);
      if (o.status === 'EM_EXECUCAO' || o.status === 'FINALIZADA') return { status: 200, body: { numeroOS: o.numeroOS } };
      if (o.status === 'LIBERADA') return conflito('ordem liberada (OS cancelada)');
      if (o.status !== 'DIAGNOSTICADA') return conflito('diagnostico nao registrado');
      o.status = 'EM_EXECUCAO';
      o.estoqueBaixado = true; // baixa efetiva das reservas
      marcar(o, 'iniciada (estoque baixado)');
      return { status: 200, body: { numeroOS: o.numeroOS } };
    },
  },
  {
    metodo: 'DELETE',
    caminho: '/execucao/ordens/{n}',
    roles: ['SERVICO'],
    comando: 'execucao.liberar-reservas',
    handler: ({ params, body }) => {
      const o = ordens.get(params.n);
      if (o) {
        if (o.status === 'EM_EXECUCAO' || o.status === 'FINALIZADA') {
          log.warn('liberar-reservas depois de iniciar: nada a devolver (a saga nao deveria compensar aqui)', { correlation_id: o.numeroOS });
        } else if (o.status !== 'LIBERADA') {
          o.status = 'LIBERADA';
          o.reservas = [];
          o.motivoLiberacao = body.motivo;
          marcar(o, `reservas liberadas (${body.motivo})`);
        }
      }
      return { status: 200, body: { numeroOS: params.n } };
    },
  },

  // ------------------------------------------------------------ acoes do mecanico
  {
    metodo: 'POST',
    caminho: '/execucao/ordens/{n}/diagnostico',
    roles: ['MECANICO', 'ADMIN'],
    handler: async ({ params, body, principal, traceparent }) => {
      const o = ordens.get(params.n);
      if (!o) return naoEncontrada(params.n);
      if (o.status !== 'NA_FILA') return conflito(`diagnostico so na fila (status ${o.status})`);
      const itens: Item[] = body?.itens ?? [];
      o.itens = itens;
      o.reservas = itens.filter((i) => i.tipo === 'PRODUTO');
      o.status = 'DIAGNOSTICADA';
      marcar(o, `diagnostico registrado (${o.reservas.length} reserva(s))`);
      const cb = await callbacks.enviar(
        o.numeroOS,
        'execucao.diagnostico-concluido',
        { mecanicoId: body?.mecanicoId ?? principal!.sub, diagnostico: body?.diagnostico ?? 'Diagnostico registrado pelo mecanico', itens },
        traceparent,
      );
      return respostaDaAcao(o.numeroOS, o, cb);
    },
  },
  {
    metodo: 'POST',
    caminho: '/execucao/ordens/{n}/finalizar',
    roles: ['MECANICO', 'ADMIN'],
    handler: async ({ params, traceparent }) => {
      const o = ordens.get(params.n);
      if (!o) return naoEncontrada(params.n);
      if (o.status !== 'EM_EXECUCAO') return conflito(`finalizar so em execucao (status ${o.status})`);
      o.status = 'FINALIZADA';
      marcar(o, 'finalizada');
      const cb = await callbacks.enviar(o.numeroOS, 'execucao.finalizada', { finalizadaEm: new Date().toISOString() }, traceparent);
      return respostaDaAcao(o.numeroOS, o, cb);
    },
  },

  // ------------------------------------------------------------ controle (so no stub)
  {
    metodo: 'GET',
    caminho: '/__stub/ordens/{n}',
    roles: null,
    handler: ({ params }) => {
      const o = ordens.get(params.n);
      return o ? { status: 200, body: o } : naoEncontrada(params.n);
    },
  },
  {
    metodo: 'POST',
    caminho: '/__stub/callbacks/{n}/reenviar',
    roles: null,
    handler: async ({ params, traceparent }) => {
      const cb = await callbacks.reenviarUltimo(params.n, traceparent);
      return cb ? respostaDaAcao(params.n, ordens.get(params.n), cb) : naoEncontrada(params.n);
    },
  },
);

servidor.ouvir(Number(process.env.PORT ?? 3002));
