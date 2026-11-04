import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, Roles, Role } from '@guilhermeqmaia/oficina-kit/auth';
import { AuditLogService } from '../application/audit-log.service';
import { CreateOrdemDeServicoDto } from './dto/create-ordem-de-servico.dto';
import { CancelarOrdemDeServicoDto } from './dto/cancelar-ordem-de-servico.dto';
import { QueryOrdemDeServicoDto } from './dto/query-ordem-de-servico.dto';
import { OrdemDeServicoPresenter } from './presenters/ordem-de-servico.presenter';
import { CriarOrdemDeServicoUseCase } from '../application/use-cases/criar-ordem-de-servico.use-case';
import { ListarOrdensDeServicoUseCase } from '../application/use-cases/listar-ordens-de-servico.use-case';
import { BuscarDetalhesOrdemDeServicoUseCase } from '../application/use-cases/buscar-detalhes-ordem-de-servico.use-case';
import { BuscarStatusPorNumeroUseCase } from '../application/use-cases/buscar-status-por-numero.use-case';
import { EntregarOrdemDeServicoUseCase } from '../application/use-cases/entregar-ordem-de-servico.use-case';
import { CancelarOrdemDeServicoUseCase } from '../application/use-cases/cancelar-ordem-de-servico.use-case';
import { DeletarOrdemDeServicoUseCase } from '../application/use-cases/deletar-ordem-de-servico.use-case';
import { ConsultarSagaUseCase } from '../saga/application/consultar-saga.use-case';
import { SagaPresenter } from '../saga/infrastructure/saga.presenter';
import { PASSOS_COM_FALHA_SIMULAVEL, PassoSaga } from '../saga/domain/saga-os.entity';
import { simulacaoDeFalhasHabilitada } from '../../config/simulacao-falhas.config';
import { ApiHeader } from '@nestjs/swagger';

/**
 * OS Service (Fase 4): apenas o ciclo de vida que e do Atendimento. Diagnostico,
 * itens e execucao ficam no Execucao Service (/execucao, /catalogo, /estoque);
 * orcamento, aprovacao e pagamento no Billing (/orcamentos, /pagamentos). As
 * transicoes correspondentes chegam pelas respostas HTTP e pelos callbacks dos participantes
 * (ver application/use-cases/transicoes e saga/).
 */
@ApiTags('Ordens de Servico')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Role insuficiente' })
@Controller('ordens-servico')
export class OrdemDeServicoController {
  constructor(
    private readonly criarOrdemDeServico: CriarOrdemDeServicoUseCase,
    private readonly listarOrdensDeServico: ListarOrdensDeServicoUseCase,
    private readonly buscarDetalhesOrdemDeServico: BuscarDetalhesOrdemDeServicoUseCase,
    private readonly buscarStatusPorNumero: BuscarStatusPorNumeroUseCase,
    private readonly entregarUseCase: EntregarOrdemDeServicoUseCase,
    private readonly cancelarUseCase: CancelarOrdemDeServicoUseCase,
    private readonly deletarOrdemDeServicoUseCase: DeletarOrdemDeServicoUseCase,
    private readonly auditLogService: AuditLogService,
    private readonly consultarSaga: ConsultarSagaUseCase,
  ) {}

  @Post()
  @Roles(Role.ADMIN, Role.ATENDENTE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Abrir nova ordem de servico (a saga chama POST /execucao/ordens na hora: com 201 a OS ja volta EM_DIAGNOSTICO)' })
  @ApiCreatedResponse({ description: 'OS criada com sucesso' })
  @ApiNotFoundResponse({ description: 'Cliente ou veiculo nao encontrado' })
  @ApiBadRequestResponse({ description: 'Dados invalidos' })
  @ApiConflictResponse({ description: 'Veiculo nao pertence ao cliente' })
  @ApiHeader({
    name: 'x-simular-falha',
    required: false,
    description:
      'Demo (US-F4-11, so com SAGA_SIMULAR_FALHA_HABILITADO=true): passo da saga em que o evento de sucesso sera tratado como falha — ' +
      PASSOS_COM_FALHA_SIMULAVEL.join(' | '),
  })
  async create(@Body() dto: CreateOrdemDeServicoDto, @Headers('x-simular-falha') simularFalha?: string) {
    let falhaSimulada: PassoSaga | null = null;
    if (simularFalha) {
      if (!simulacaoDeFalhasHabilitada()) throw new BadRequestException('Injecao de falhas desabilitada neste ambiente');
      const passo = simularFalha.trim().toUpperCase() as PassoSaga;
      if (!PASSOS_COM_FALHA_SIMULAVEL.includes(passo)) {
        throw new BadRequestException(`x-simular-falha invalido; use um de: ${PASSOS_COM_FALHA_SIMULAVEL.join(', ')}`);
      }
      falhaSimulada = passo;
    }
    const os = await this.criarOrdemDeServico.execute({ ...dto, falhaSimulada });
    return OrdemDeServicoPresenter.toResponse(os);
  }

  @Get()
  @Roles(Role.ADMIN, Role.ATENDENTE, Role.MECANICO)
  @ApiOperation({
    summary: 'Listar ordens de servico com paginacao, filtros e ordenacao por prioridade de status',
    description:
      'Ordem: AGUARDANDO_PAGAMENTO > EM_EXECUCAO > AGUARDANDO_APROVACAO > EM_DIAGNOSTICO > RECEBIDA; mais antigas primeiro. ' +
      'FINALIZADA/ENTREGUE/CANCELADA ficam de fora por padrao (incluirEncerradas=true para incluir).',
  })
  @ApiOkResponse({ description: 'Lista paginada de OS' })
  async findAll(@Query() query: QueryOrdemDeServicoDto) {
    const result = await this.listarOrdensDeServico.execute({
      page: query.page ?? 1,
      limit: query.limit ?? 10,
      clienteId: query.clienteId,
      status: query.status,
      numero: query.numero,
      incluirEncerradas: query.incluirEncerradas,
    });
    return OrdemDeServicoPresenter.toPaginatedResponse(result);
  }

  @Get('numero/:numero/status')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Acompanhar OS pelo numero (publico, sem autenticacao) — US-16' })
  @ApiOkResponse({ description: 'Status e itens (snapshot) da OS' })
  @ApiNotFoundResponse({ description: 'OS nao encontrada para o numero informado' })
  async findStatusByNumero(@Param('numero') numero: string) {
    return this.buscarStatusPorNumero.execute({ numero });
  }

  @Get('numero/:numero/saga')
  @Roles(Role.ADMIN, Role.ATENDENTE, Role.MECANICO)
  @ApiOperation({
    summary: 'Linha do tempo da saga da OS (US-F4-10)',
    description:
      'Passo atual, status (EM_ANDAMENTO/COMPENSANDO/CONCLUIDA/CANCELADA), historico de eventos (avancou/ignorado/compensando), ' +
      'compensacoes enviadas e confirmadas e prazos de aprovacao/pagamento — rastreamento do fluxo distribuido.',
  })
  @ApiOkResponse({ description: 'Estado da saga' })
  @ApiNotFoundResponse({ description: 'OS sem saga (nao encontrada)' })
  async findSaga(@Param('numero') numero: string) {
    return SagaPresenter.toResponse(await this.consultarSaga.execute({ numero }));
  }

  @Get(':id/audit-log')
  @Roles(Role.ADMIN, Role.ATENDENTE)
  @ApiOperation({ summary: 'Listar audit log da OS (transicoes e acoes registradas)' })
  @ApiOkResponse({ description: 'Log em ordem cronologica' })
  async findAuditLog(@Param('id', ParseUUIDPipe) id: string) {
    const logs = await this.auditLogService.findByOrdemDeServicoId(id);
    return logs.map((log) => ({
      id: log.id,
      acao: log.acao,
      statusAnterior: log.statusAnterior,
      statusNovo: log.statusNovo,
      usuarioId: log.usuarioId,
      metadata: log.metadata,
      createdAt: log.createdAt,
    }));
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.ATENDENTE, Role.MECANICO)
  @ApiOperation({ summary: 'Buscar ordem de servico por ID (cabecalho, corpo, rodape)' })
  @ApiOkResponse({ description: 'OS encontrada (view detalhada)' })
  @ApiNotFoundResponse({ description: 'OS nao encontrada' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.buscarDetalhesOrdemDeServico.execute({ id });
  }

  @Post(':id/entregar')
  @Roles(Role.ADMIN, Role.ATENDENTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Entregar veiculo (encerrar OS; so depois de paga = FINALIZADA)' })
  @ApiConflictResponse({ description: 'OS alterada por outra operacao ao mesmo tempo (releia e repita)' })
  @ApiOkResponse({ description: 'Veiculo entregue com sucesso' })
  @ApiNotFoundResponse({ description: 'OS nao encontrada' })
  @ApiBadRequestResponse({ description: 'Transicao de status invalida' })
  async entregar(@Param('id', ParseUUIDPipe) id: string) {
    const os = await this.entregarUseCase.execute({ id });
    return OrdemDeServicoPresenter.toResponse(os);
  }

  @Post(':id/cancelar')
  @Roles(Role.ADMIN, Role.ATENDENTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar OS (so antes da execucao comecar; a saga chama DELETE /orcamentos e DELETE /execucao/ordens — US-F4-10/US-F4-18)' })
  @ApiConflictResponse({ description: 'OS alterada por outra operacao ao mesmo tempo (releia e repita)' })
  @ApiOkResponse({ description: 'OS cancelada' })
  @ApiNotFoundResponse({ description: 'OS nao encontrada' })
  @ApiBadRequestResponse({ description: 'OS ja em execucao/finalizada — nao pode ser cancelada' })
  async cancelar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelarOrdemDeServicoDto) {
    const os = await this.cancelarUseCase.execute({ id, motivo: dto.motivo });
    return OrdemDeServicoPresenter.toResponse(os);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deletar ordem de servico' })
  @ApiNotFoundResponse({ description: 'OS nao encontrada' })
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    await this.deletarOrdemDeServicoUseCase.execute({ id });
  }
}
