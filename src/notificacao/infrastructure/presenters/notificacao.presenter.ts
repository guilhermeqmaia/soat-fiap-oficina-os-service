import { Notificacao } from '../../domain/notificacao.entity';
import { NotificacaoResponseDto } from '../dto/notificacao-response.dto';
import { PaginatedResult } from '../../domain/notificacao.repository';

export class NotificacaoPresenter {
  static toResponse(n: Notificacao): NotificacaoResponseDto {
    return {
      id: n.id!,
      clienteId: n.clienteId,
      ordemDeServicoId: n.ordemDeServicoId,
      numeroOS: n.numeroOS,
      eventoId: n.eventoId,
      linkPagamento: n.linkPagamento,
      tipo: n.tipo,
      canal: n.canal,
      destinatario: n.destinatario,
      assunto: n.assunto,
      mensagem: n.mensagem,
      status: n.status,
      erro: n.erro,
      enviadaEm: n.enviadaEm,
      createdAt: n.createdAt!,
    };
  }

  static toPaginatedResponse(result: PaginatedResult<Notificacao>) {
    return {
      data: result.data.map((n) => NotificacaoPresenter.toResponse(n)),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }
}
