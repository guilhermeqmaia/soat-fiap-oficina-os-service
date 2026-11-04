import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UsuarioRepository, FindAllParams, PaginatedResult } from '../domain/usuario.repository';
import { Usuario } from '../../auth/domain/usuario.entity';
import { Role } from '@guilhermeqmaia/oficina-kit/auth';

/** SERVICO e role de JWT entre servicos (RFC-0008), nunca de usuario — o dominio ja bloqueia. */
type RoleDeUsuario = Exclude<Role, Role.SERVICO>;

@Injectable()
export class PrismaUsuarioRepository implements UsuarioRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(usuario: Usuario): Promise<Usuario> {
    const created = await this.prisma.usuario.create({
      data: {
        nome: usuario.nome,
        email: usuario.email.value,
        cpf: usuario.cpf,
        senhaHash: usuario.senhaHash,
        role: usuario.role as RoleDeUsuario,
        ativo: usuario.ativo,
      },
    });

    return Usuario.reconstitute({
      id: created.id,
      nome: created.nome,
      email: created.email,
      cpf: created.cpf,
      senhaHash: created.senhaHash,
      role: created.role as any,
      ativo: created.ativo,
    });
  }

  async findById(id: string): Promise<Usuario | null> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id },
    });

    if (!usuario) return null;

    return Usuario.reconstitute({
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      cpf: usuario.cpf,
      senhaHash: usuario.senhaHash,
      role: usuario.role as any,
      ativo: usuario.ativo,
    });
  }

  async findByEmail(email: string): Promise<Usuario | null> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { email },
    });

    if (!usuario) return null;

    return Usuario.reconstitute({
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      cpf: usuario.cpf,
      senhaHash: usuario.senhaHash,
      role: usuario.role as any,
      ativo: usuario.ativo,
    });
  }

  async findAll(
    params: FindAllParams,
  ): Promise<PaginatedResult<Usuario>> {
    const skip = ((params.page ?? 1) - 1) * (params.limit ?? 10);

    const where: any = {};
    if (params.role) where.role = params.role;
    if (params.ativo !== undefined) where.ativo = params.ativo;

    const [data, total] = await Promise.all([
      this.prisma.usuario.findMany({
        where,
        skip,
        take: params.limit ?? 10,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.usuario.count({ where }),
    ]);

    return {
      data: data.map((d) =>
        Usuario.reconstitute({
          id: d.id,
          nome: d.nome,
          email: d.email,
          cpf: d.cpf,
          senhaHash: d.senhaHash,
          role: d.role as any,
          ativo: d.ativo,
        }),
      ),
      total,
      page: params.page ?? 1,
      limit: params.limit ?? 10,
    };
  }

  async update(usuario: Usuario): Promise<Usuario> {
    const updated = await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: {
        nome: usuario.nome,
        email: usuario.email.value,
        cpf: usuario.cpf,
        role: usuario.role as RoleDeUsuario,
        ativo: usuario.ativo,
      },
    });

    return Usuario.reconstitute({
      id: updated.id,
      nome: updated.nome,
      email: updated.email,
      cpf: updated.cpf,
      senhaHash: updated.senhaHash,
      role: updated.role as any,
      ativo: updated.ativo,
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.usuario.delete({
      where: { id },
    });
  }
}
