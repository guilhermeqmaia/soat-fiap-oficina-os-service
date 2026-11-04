import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Usuario } from '../domain/usuario.entity';
import { UsuarioRepository } from '../domain/usuario.repository';
import { Role } from '@guilhermeqmaia/oficina-kit/auth';

@Injectable()
export class PrismaUsuarioRepository implements UsuarioRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<Usuario | null> {
    const record = await this.prisma.usuario.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!record) return null;
    return this.toDomain(record);
  }

  async findById(id: string): Promise<Usuario | null> {
    const record = await this.prisma.usuario.findUnique({ where: { id } });
    if (!record) return null;
    return this.toDomain(record);
  }

  async create(usuario: Usuario): Promise<Usuario> {
    const record = await this.prisma.usuario.create({
      data: {
        nome: usuario.nome,
        email: usuario.email.value,
        cpf: usuario.cpf,
        senhaHash: usuario.senhaHash,
        // SERVICO e role de JWT entre servicos, nunca de usuario (o dominio ja bloqueia).
        role: usuario.role as Exclude<Role, Role.SERVICO>,
        ativo: usuario.ativo,
      },
    });
    return this.toDomain(record);
  }

  private toDomain(record: {
    id: string;
    nome: string;
    email: string;
    cpf?: string | null;
    senhaHash: string;
    role: string;
    ativo: boolean;
  }): Usuario {
    return Usuario.reconstitute({
      id: record.id,
      nome: record.nome,
      email: record.email,
      cpf: record.cpf,
      senhaHash: record.senhaHash,
      role: record.role as Role,
      ativo: record.ativo,
    });
  }
}
