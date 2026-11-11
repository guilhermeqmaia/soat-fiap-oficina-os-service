import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { QueryUsuarioDto } from './dto/query-usuario.dto';
import { JwtAuthGuard, RolesGuard, Roles, Role } from '@guilhermeqmaia/oficina-kit/auth';
import { UsuarioOutput } from '../application/usuario-output';
import { CriarUsuarioUseCase } from '../application/use-cases/criar-usuario.use-case';
import { BuscarUsuarioPorIdUseCase } from '../application/use-cases/buscar-usuario-por-id.use-case';
import { ListarUsuariosUseCase } from '../application/use-cases/listar-usuarios.use-case';
import { AtualizarUsuarioUseCase } from '../application/use-cases/atualizar-usuario.use-case';
import { DeletarUsuarioUseCase } from '../application/use-cases/deletar-usuario.use-case';
import { PaginatedResult } from '../application/gateways/usuario.gateway';

@ApiTags('Usuario')
@ApiUnauthorizedResponse({ description: 'Token JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Somente ADMIN' })
@Controller('usuario')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsuarioController {
  constructor(
    private readonly criarUsuario: CriarUsuarioUseCase,
    private readonly buscarUsuarioPorId: BuscarUsuarioPorIdUseCase,
    private readonly listarUsuarios: ListarUsuariosUseCase,
    private readonly atualizarUsuario: AtualizarUsuarioUseCase,
    private readonly deletarUsuario: DeletarUsuarioUseCase,
  ) {}

  @Post()
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Criar novo usuário' })
  @ApiBearerAuth()
  @ApiCreatedResponse({
    description: 'Usuário criado com sucesso',
    schema: {
      example: {
        id: 'uuid-123',
        nome: 'João Mecânico',
        email: 'joao@mecanica.com',
        role: 'MECANICO',
        ativo: true,
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Dados inválidos' })
  @ApiConflictResponse({ description: 'Email já registrado' })
  async create(@Body() dto: CreateUsuarioDto): Promise<UsuarioOutput> {
    return this.criarUsuario.execute(dto);
  }

  @Get()
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Listar usuários com paginação' })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Lista de usuários',
    schema: {
      example: {
        data: [
          {
            id: 'uuid-123',
            nome: 'João',
            email: 'joao@test.com',
            role: 'MECANICO',
            ativo: true,
          },
        ],
        total: 1,
        page: 1,
        limit: 10,
      },
    },
  })
  async findAll(@Query() query: QueryUsuarioDto): Promise<PaginatedResult<UsuarioOutput>> {
    return this.listarUsuarios.execute(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buscar usuário por ID' })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Usuário encontrado',
    schema: {
      example: {
        id: 'uuid-123',
        nome: 'João',
        email: 'joao@test.com',
        role: 'MECANICO',
        ativo: true,
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Usuário não encontrado' })
  async findById(@Param('id') id: string): Promise<UsuarioOutput> {
    return this.buscarUsuarioPorId.execute({ id });
  }

  @Put(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atualizar usuário' })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Usuário atualizado com sucesso',
    schema: {
      example: {
        id: 'uuid-123',
        nome: 'João Atualizado',
        email: 'joao.novo@test.com',
        role: 'ATENDENTE',
        ativo: false,
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Usuário não encontrado' })
  @ApiConflictResponse({ description: 'Email já registrado' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUsuarioDto,
  ): Promise<UsuarioOutput> {
    return this.atualizarUsuario.execute({ id, ...dto });
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deletar usuário' })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Usuário deletado com sucesso' })
  @ApiNotFoundResponse({ description: 'Usuário não encontrado' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.deletarUsuario.execute({ id });
  }
}
