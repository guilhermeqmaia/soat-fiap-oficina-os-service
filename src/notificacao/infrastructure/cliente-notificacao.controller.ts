import {
  BadRequestException,
  ForbiddenException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role, CurrentUser, Roles, AuthenticatedUser } from '@guilhermeqmaia/oficina-kit/auth';
import { ListarNotificacoesPorCpfCnpjUseCase } from '../application/use-cases/listar-notificacoes-por-cpf-cnpj.use-case';
import { NotificacoesPaginadasDto } from './dto/notificacoes-paginadas.dto';
import { QueryNotificacaoDto } from './dto/query-notificacao.dto';
import { NotificacaoPresenter } from './presenters/notificacao.presenter';

const CPF_CNPJ_DIGITS_REGEX = /^\d{11}(\d{3})?$/;

@ApiTags('Notificacoes')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT ausente ou invalido' })
@ApiForbiddenResponse({
  description: 'Role insuficiente ou CPF/CNPJ nao pertence ao usuario',
})
@Controller('clientes')
export class ClienteNotificacaoController {
  constructor(
    private readonly useCase: ListarNotificacoesPorCpfCnpjUseCase,
  ) {}

  @Get(':cpfCnpj/notificacoes')
  @Roles(Role.CLIENTE)
  @ApiOperation({
    summary: 'Historico de notificacoes do cliente autenticado',
  })
  @ApiOkResponse({
    description: 'Notificacoes paginadas',
    type: NotificacoesPaginadasDto,
  })
  @ApiNotFoundResponse({ description: 'Cliente nao encontrado pelo CPF/CNPJ' })
  async findByCpfCnpj(
    @Param('cpfCnpj') cpfCnpj: string,
    @Query() query: QueryNotificacaoDto,
    @CurrentUser() usuario: AuthenticatedUser,
  ) {
    if (!CPF_CNPJ_DIGITS_REGEX.test(cpfCnpj)) {
      throw new BadRequestException(
        'CPF/CNPJ deve conter apenas digitos (11 para CPF ou 14 para CNPJ)',
      );
    }
    // Resource server (US-F3-03): posse provada pela claim `cpf` do token.
    if (!usuario.possuiDocumento(cpfCnpj)) {
      throw new ForbiddenException('CPF/CNPJ nao pertence ao usuario autenticado');
    }

    const result = await this.useCase.execute({
      cpfCnpj,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });

    return NotificacaoPresenter.toPaginatedResponse(result);
  }
}
