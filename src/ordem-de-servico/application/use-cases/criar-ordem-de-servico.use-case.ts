import { Inject, Injectable } from '@nestjs/common';
import { UseCase } from '@guilhermeqmaia/oficina-kit/core';
import { OrdemDeServico } from '../../domain/ordem-de-servico.entity';
import { ClienteNotFoundError } from '../../domain/errors/cliente-not-found.error';
import { VeiculoNotFoundError } from '../../domain/errors/veiculo-not-found.error';
import { VeiculoClienteMismatchError } from '../../domain/errors/veiculo-cliente-mismatch.error';
import { ORDEM_DE_SERVICO_GATEWAY, OrdemDeServicoGateway } from '../gateways/ordem-de-servico.gateway';
import { OrquestradorSagaService } from '../../saga/application/orquestrador-saga.service';
import { PassoSaga } from '../../saga/domain/saga-os.entity';
import { UNIT_OF_WORK, UnitOfWork } from '../ports/unit-of-work';
import {
  CLIENTE_CONSULTA_GATEWAY,
  ClienteConsultaGateway,
  VEICULO_CONSULTA_GATEWAY,
  VeiculoConsultaGateway,
} from '../gateways/consulta.gateways';

export interface CriarOrdemDeServicoInput {
  clienteId: string;
  veiculoId: string;
  descricaoInicial: string;
  /** Demo (US-F4-11): passo da saga em que simular a falha do participante. */
  falhaSimulada?: PassoSaga | null;
}

/**
 * Abre a OS (RECEBIDA). Servicos/pecas nao entram mais na abertura: sao
 * definidos no diagnostico pelo Execucao Service e chegam pelo callback
 * `execucao.diagnostico-concluido`. A abertura grava OS + saga numa transacao e,
 * DEPOIS do commit, a saga chama `POST /execucao/ordens` (US-F4-10/US-F4-18): se
 * a Execucao responder na hora, a OS devolvida ja esta EM_DIAGNOSTICO.
 */
@Injectable()
export class CriarOrdemDeServicoUseCase implements UseCase<CriarOrdemDeServicoInput, OrdemDeServico> {
  constructor(
    @Inject(ORDEM_DE_SERVICO_GATEWAY)
    private readonly gateway: OrdemDeServicoGateway,
    @Inject(CLIENTE_CONSULTA_GATEWAY)
    private readonly clienteGateway: ClienteConsultaGateway,
    @Inject(VEICULO_CONSULTA_GATEWAY)
    private readonly veiculoGateway: VeiculoConsultaGateway,
    private readonly orquestrador: OrquestradorSagaService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(input: CriarOrdemDeServicoInput): Promise<OrdemDeServico> {
    const cliente = await this.clienteGateway.findById(input.clienteId);
    if (!cliente) throw new ClienteNotFoundError(input.clienteId);

    const veiculo = await this.veiculoGateway.findById(input.veiculoId);
    if (!veiculo) throw new VeiculoNotFoundError(input.veiculoId);
    if (veiculo.clienteId !== input.clienteId) {
      throw new VeiculoClienteMismatchError(input.veiculoId, input.clienteId);
    }

    const ordem = OrdemDeServico.create({
      clienteId: input.clienteId,
      veiculoId: input.veiculoId,
      descricaoInicial: input.descricaoInicial,
    });
    // OS + saga numa unica transacao: nao existe OS sem saga (US-F4-10). O
    // comando `execucao.enfileirar` so sai depois do commit (unit of work).
    const { criada, saga, comandos } = await this.uow.executar(async (tx) => {
      const criada = await this.gateway.create(ordem, tx);
      const { saga, comandos } = await this.orquestrador.iniciar(
        criada,
        { descricaoProblema: input.descricaoInicial, falhaSimulada: input.falhaSimulada ?? null },
        tx,
      );
      return { criada, saga, comandos };
    });
    await this.orquestrador.executarComandos(saga, comandos);
    return (await this.gateway.findByNumero(criada.numero)) ?? criada;
  }
}
