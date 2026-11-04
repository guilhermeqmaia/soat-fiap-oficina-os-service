import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ClienteModule } from '../cliente/cliente.module';
import { VeiculoModule } from '../veiculo/veiculo.module';
import { UsuarioModule } from '../usuario/usuario.module';
import { CLIENTE_REPOSITORY } from '../cliente/domain/cliente.repository';
import { VEICULO_REPOSITORY } from '../veiculo/domain/veiculo.repository';
import { USUARIO_REPOSITORY } from '../usuario/domain/usuario.repository';
import { OrdemDeServicoController } from './infrastructure/ordem-de-servico.controller';
import { ClienteOrdemDeServicoController } from './infrastructure/cliente-ordem-de-servico.controller';
import { SagaAdminController } from './saga/infrastructure/saga-admin.controller';
import { PrismaOrdemDeServicoRepository } from './infrastructure/prisma-ordem-de-servico.repository';
import { PrismaAuditLogRepository } from './infrastructure/prisma-audit-log.repository';
import { ORDEM_DE_SERVICO_REPOSITORY } from './domain/ordem-de-servico.repository';
import { AUDIT_LOG_REPOSITORY } from './domain/audit-log.repository';
import { AuditLogService } from './application/audit-log.service';
import { OsAuditListener } from './application/listeners/os-audit.listener';
import { ORDEM_DE_SERVICO_GATEWAY } from './application/gateways/ordem-de-servico.gateway';
import {
  CLIENTE_CONSULTA_GATEWAY,
  USUARIO_CONSULTA_GATEWAY,
  VEICULO_CONSULTA_GATEWAY,
} from './application/gateways/consulta.gateways';
import { CriarOrdemDeServicoUseCase } from './application/use-cases/criar-ordem-de-servico.use-case';
import { ListarOrdensDeServicoUseCase } from './application/use-cases/listar-ordens-de-servico.use-case';
import { BuscarDetalhesOrdemDeServicoUseCase } from './application/use-cases/buscar-detalhes-ordem-de-servico.use-case';
import { BuscarStatusPorNumeroUseCase } from './application/use-cases/buscar-status-por-numero.use-case';
import { EntregarOrdemDeServicoUseCase } from './application/use-cases/entregar-ordem-de-servico.use-case';
import { CancelarOrdemDeServicoUseCase } from './application/use-cases/cancelar-ordem-de-servico.use-case';
import { DeletarOrdemDeServicoUseCase } from './application/use-cases/deletar-ordem-de-servico.use-case';
import { ListarHistoricoPorCpfCnpjUseCase } from './application/use-cases/listar-historico-por-cpf-cnpj.use-case';
import {
  RegistrarCancelamentoUseCase,
  RegistrarDiagnosticoUseCase,
  RegistrarEnfileiramentoUseCase,
  RegistrarExecucaoFinalizadaUseCase,
  RegistrarExecucaoIniciadaUseCase,
  RegistrarOrcamentoGeradoUseCase,
  RegistrarPagamentoAprovadoUseCase,
} from './application/use-cases/transicoes';
import { OrquestradorSagaService } from './saga/application/orquestrador-saga.service';
import { SagaTimeoutsService } from './saga/application/saga-timeouts.service';
import { ConsultarSagaUseCase } from './saga/application/consultar-saga.use-case';
import { PrismaSagaRepository } from './saga/infrastructure/prisma-saga.repository';
import { SAGA_REPOSITORY } from './saga/domain/saga.repository';
import { PrismaUnitOfWork } from './infrastructure/prisma-unit-of-work';
import { UNIT_OF_WORK } from './application/ports/unit-of-work';
import { ReceberCallbackUseCase } from './saga/application/receber-callback.use-case';
import { PARTICIPANTES_SAGA_GATEWAY } from './saga/application/ports/participantes-saga.gateway';
import { CALLBACKS_PROCESSADOS } from './saga/application/ports/callbacks-processados';
import { HttpParticipantesSaga, URLS_PARTICIPANTES } from './saga/infrastructure/http-participantes-saga';
import { PrismaCallbacksProcessadosRepository } from './saga/infrastructure/prisma-callbacks-processados.repository';
import { PurgaCallbacksService } from './saga/infrastructure/purga-callbacks.service';
import { CallbackSagaController } from './saga/infrastructure/callback-saga.controller';
import { urlsDosParticipantes } from '../config/servicos.config';

const USE_CASES = [
  CriarOrdemDeServicoUseCase,
  ListarOrdensDeServicoUseCase,
  BuscarDetalhesOrdemDeServicoUseCase,
  BuscarStatusPorNumeroUseCase,
  EntregarOrdemDeServicoUseCase,
  CancelarOrdemDeServicoUseCase,
  DeletarOrdemDeServicoUseCase,
  ListarHistoricoPorCpfCnpjUseCase,
];

/** Transicoes dirigidas pelos eventos de Execucao/Billing — chamadas pelo orquestrador da saga (US-F4-10). */
export const TRANSICOES_USE_CASES = [
  RegistrarEnfileiramentoUseCase,
  RegistrarDiagnosticoUseCase,
  RegistrarOrcamentoGeradoUseCase,
  RegistrarExecucaoIniciadaUseCase,
  RegistrarExecucaoFinalizadaUseCase,
  RegistrarPagamentoAprovadoUseCase,
  RegistrarCancelamentoUseCase,
];

@Module({
  imports: [PrismaModule, ClienteModule, VeiculoModule, UsuarioModule],
  controllers: [OrdemDeServicoController, ClienteOrdemDeServicoController, SagaAdminController, CallbackSagaController],
  providers: [
    ...USE_CASES,
    ...TRANSICOES_USE_CASES,
    // Saga orquestrada (RFC-0005 / US-F4-10) — participantes por HTTP (RFC-0008 / US-F4-18)
    OrquestradorSagaService,
    SagaTimeoutsService,
    ConsultarSagaUseCase,
    ReceberCallbackUseCase,
    PrismaSagaRepository,
    { provide: SAGA_REPOSITORY, useExisting: PrismaSagaRepository },
    { provide: URLS_PARTICIPANTES, useFactory: () => urlsDosParticipantes() },
    HttpParticipantesSaga,
    { provide: PARTICIPANTES_SAGA_GATEWAY, useExisting: HttpParticipantesSaga },
    PrismaCallbacksProcessadosRepository,
    { provide: CALLBACKS_PROCESSADOS, useExisting: PrismaCallbacksProcessadosRepository },
    PurgaCallbacksService,
    PrismaUnitOfWork,
    { provide: UNIT_OF_WORK, useExisting: PrismaUnitOfWork },
    AuditLogService,
    OsAuditListener,
    PrismaOrdemDeServicoRepository,
    PrismaAuditLogRepository,
    { provide: ORDEM_DE_SERVICO_REPOSITORY, useExisting: PrismaOrdemDeServicoRepository },
    { provide: AUDIT_LOG_REPOSITORY, useExisting: PrismaAuditLogRepository },
    { provide: ORDEM_DE_SERVICO_GATEWAY, useExisting: PrismaOrdemDeServicoRepository },
    { provide: CLIENTE_CONSULTA_GATEWAY, useExisting: CLIENTE_REPOSITORY },
    { provide: VEICULO_CONSULTA_GATEWAY, useExisting: VEICULO_REPOSITORY },
    { provide: USUARIO_CONSULTA_GATEWAY, useExisting: USUARIO_REPOSITORY },
  ],
  exports: [ORDEM_DE_SERVICO_REPOSITORY, ORDEM_DE_SERVICO_GATEWAY, AuditLogService, OrquestradorSagaService, ...TRANSICOES_USE_CASES],
})
export class OrdemDeServicoModule {}
