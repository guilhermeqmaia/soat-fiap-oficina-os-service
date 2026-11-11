import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role, Roles } from '@guilhermeqmaia/oficina-kit/auth';
import { ListarNotificacoesUseCase } from '../application/use-cases/listar-notificacoes.use-case';
import { NotificacoesPaginadasDto } from './dto/notificacoes-paginadas.dto';
import { QueryNotificacaoDto } from './dto/query-notificacao.dto';
import { NotificacaoPresenter } from './presenters/notificacao.presenter';

@ApiTags('Notificacoes')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Role insuficiente' })
@Controller('notificacoes')
export class NotificacaoController {
  constructor(private readonly useCase: ListarNotificacoesUseCase) {}

  @Get()
  @Roles(Role.ADMIN, Role.ATENDENTE)
  @ApiOperation({ summary: 'Listar historico de notificacoes enviadas' })
  @ApiOkResponse({
    description: 'Notificacoes paginadas',
    type: NotificacoesPaginadasDto,
  })
  async findAll(@Query() query: QueryNotificacaoDto) {
    const result = await this.useCase.execute({
      page: query.page ?? 1,
      limit: query.limit ?? 10,
      clienteId: query.clienteId,
      ordemDeServicoId: query.ordemDeServicoId,
    });

    return NotificacaoPresenter.toPaginatedResponse(result);
  }
}
