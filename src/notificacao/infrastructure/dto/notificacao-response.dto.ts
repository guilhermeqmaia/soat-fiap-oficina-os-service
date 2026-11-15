import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CanalNotificacao } from '../../domain/value-objects/canal-notificacao.vo';
import { StatusNotificacao } from '../../domain/value-objects/status-notificacao.vo';
import { TipoNotificacao } from '../../domain/value-objects/tipo-notificacao.vo';

export class NotificacaoResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  clienteId!: string;

  @ApiProperty({ nullable: true, type: String })
  ordemDeServicoId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'OS-2026-000001',
    description: 'Numero da OS (US-F4-12; null em notificacoes anteriores)',
  })
  numeroOS?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Id do fato que originou a notificacao (id do envelope do callback ou id deterministico); ' +
      'unico por tipo + canal — garante uma notificacao por fato',
  })
  eventoId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123',
    description: 'Link de pagamento (so em PAGAMENTO_PENDENTE, vindo de billing.cobranca-criada)',
  })
  linkPagamento?: string | null;

  @ApiProperty({ enum: TipoNotificacao })
  tipo!: TipoNotificacao;

  @ApiProperty({
    enum: CanalNotificacao,
    description: 'Canal real do envio (WEBHOOK quando NOTIFICATION_PROVIDER=webhook)',
  })
  canal!: CanalNotificacao;

  @ApiProperty()
  destinatario!: string;

  @ApiProperty()
  assunto!: string;

  @ApiProperty()
  mensagem!: string;

  @ApiProperty({ enum: StatusNotificacao })
  status!: StatusNotificacao;

  @ApiProperty({ nullable: true, type: String })
  erro!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  enviadaEm!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
