import { Inject, Injectable } from '@nestjs/common';
import { UseCase } from '@guilhermeqmaia/oficina-kit/core';
import {
  PASSWORD_HASHER,
  PasswordHasher,
} from '../../../shared/application/password-hasher';
import { Usuario } from '../../../auth/domain/usuario.entity';
import { Role } from '@guilhermeqmaia/oficina-kit/auth';
import { InvalidRoleError } from '../../domain/errors/invalid-role.error';
import { EmailAlreadyExistsError } from '../../domain/errors/email-already-exists.error';
import { USUARIO_GATEWAY, UsuarioGateway } from '../gateways/usuario.gateway';
import { UsuarioOutput } from '../usuario-output';

export interface CriarUsuarioInput {
  nome: string;
  email: string;
  cpf?: string;
  senha: string;
  role: string;
}

@Injectable()
export class CriarUsuarioUseCase
  implements UseCase<CriarUsuarioInput, UsuarioOutput>
{
  constructor(
    @Inject(USUARIO_GATEWAY)
    private readonly gateway: UsuarioGateway,
    @Inject(PASSWORD_HASHER)
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async execute(input: CriarUsuarioInput): Promise<UsuarioOutput> {
    // SERVICO e a role dos JWTs entre servicos (RFC-0008): nao existe usuario com ela.
    if (!Object.values(Role).includes(input.role as Role) || input.role === Role.SERVICO) {
      throw new InvalidRoleError(input.role);
    }

    const usuarioExistente = await this.gateway.findByEmail(input.email);
    if (usuarioExistente) {
      throw new EmailAlreadyExistsError(input.email);
    }

    const senhaHash = await this.passwordHasher.hash(input.senha);

    const usuario = Usuario.create({
      nome: input.nome,
      email: input.email,
      cpf: input.cpf ?? null,
      senhaHash,
      role: input.role as Role,
    });

    const created = await this.gateway.create(usuario);
    return {
      id: created.id,
      nome: created.nome,
      email: created.email.value,
      cpf: created.cpf,
      role: created.role,
      ativo: created.ativo,
    };
  }
}
