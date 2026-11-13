# language: pt
# US-F4-14 — BDD do fluxo da Ordem de Serviço no OS Service (nível de serviço).
# Execução e Billing são stubs HTTP que respondem como docs/contratos/http-interno.md;
# os callbacks deles chegam em POST /ordens-servico/{numero}/eventos com JWT de SERVICO.

@os-service @saga
Funcionalidade: Ciclo de vida da Ordem de Serviço orquestrado pela saga
  Como atendente da oficina
  Quero que a OS avance sozinha conforme Execução e Billing respondem
  Para que o cliente seja cobrado depois do serviço feito e as falhas sejam compensadas

  Contexto:
    Dado que existe um cliente com veículo

  @caminho-feliz
  Cenário: Caminho feliz da abertura à entrega do veículo
    Quando o atendente abre uma OS para o veículo
    Então a OS fica com status "EM_DIAGNOSTICO"
    E a saga fica no passo "AGUARDAR_DIAGNOSTICO" com status "EM_ANDAMENTO"
    E o serviço "Execução" recebeu a chamada "POST /execucao/ordens" com o JWT de serviço do OS Service

    Quando o serviço "Execução" envia o callback "execucao.diagnostico-concluido" para a OS
    Então o callback é aplicado
    E o serviço "Billing" recebeu 1 chamada em "POST /orcamentos"
    E a OS fica com status "AGUARDANDO_APROVACAO"
    E a saga fica no passo "AGUARDAR_APROVACAO" com status "EM_ANDAMENTO"
    E o cliente recebe a notificação "ORCAMENTO_PRONTO"

    Quando o serviço "Billing" envia o callback "billing.orcamento-aprovado" para a OS
    Então o serviço "Execução" recebeu 1 chamada em "POST /execucao/ordens/{n}/iniciar"
    E a OS fica com status "EM_EXECUCAO"
    E a saga fica no passo "AGUARDAR_FINALIZACAO" com status "EM_ANDAMENTO"

    Quando o serviço "Execução" envia o callback "execucao.finalizada" para a OS
    Então o serviço "Billing" recebeu 1 chamada em "POST /orcamentos/{n}/cobrar"
    E a OS fica com status "AGUARDANDO_PAGAMENTO"
    E a saga fica no passo "AGUARDAR_PAGAMENTO" com status "EM_ANDAMENTO"
    # Próxima etapa (US-F4-12): notificação "PAGAMENTO_PENDENTE" com o linkPagamento
    # devolvido no 201 de POST /orcamentos/{n}/cobrar.

    Quando o serviço "Billing" envia o callback "billing.pagamento-aprovado" para a OS
    Então a OS fica com status "FINALIZADA"
    E a saga fica no passo "CONCLUIDA" com status "CONCLUIDA"
    E a saga não tem compensações
    E o cliente recebe a notificação "OS_FINALIZADA"
    # Próxima etapa (US-F4-12): notificação "PAGAMENTO_APROVADO".

    Quando o atendente entrega o veículo
    Então a resposta tem status HTTP 200
    E a OS fica com status "ENTREGUE"

  @compensacao
  Cenário: Cliente rejeita o orçamento e a saga compensa liberando as reservas
    Dado que existe uma OS no status "AGUARDANDO_APROVACAO"
    Quando o serviço "Billing" envia o callback "billing.orcamento-rejeitado" para a OS
    Então o callback é aplicado
    E o serviço "Execução" recebeu 1 chamada em "DELETE /execucao/ordens/{n}"
    E o serviço "Execução" não recebeu chamadas em "POST /execucao/ordens/{n}/iniciar"
    E a OS é cancelada com o motivo "ORCAMENTO_REJEITADO"
    E a saga fica no passo "AGUARDAR_APROVACAO" com status "CANCELADA"
    E as compensações confirmadas da saga são "execucao.liberar-reservas"
    E o histórico da saga termina com "execucao.reservas-liberadas" e resultado "cancelada"
    # Próxima etapa (US-F4-12): notificação "OS_CANCELADA".

  @pagamento
  Cenário: Pagamento recusado mantém a OS aguardando pagamento, sem rollback
    Dado que existe uma OS no status "AGUARDANDO_PAGAMENTO"
    Quando o serviço "Billing" envia o callback "billing.pagamento-recusado" para a OS
    Então o callback é aplicado
    E a OS permanece com status "AGUARDANDO_PAGAMENTO"
    E a saga fica no passo "AGUARDAR_PAGAMENTO" com status "EM_ANDAMENTO"
    E a saga não tem compensações
    E o histórico da saga termina com "billing.pagamento-recusado" e resultado "pagamento-pendente"
    E o serviço "Execução" não recebeu chamadas em "DELETE /execucao/ordens/{n}"
    E o cliente não recebe a notificação "OS_FINALIZADA"
    # Próxima etapa (US-F4-12): notificação "PAGAMENTO_RECUSADO".

    Quando o atendente cancela a OS
    Então a resposta tem status HTTP 400
    E a OS permanece com status "AGUARDANDO_PAGAMENTO"

    Quando o administrador reprocessa a saga
    Então o serviço "Billing" recebeu 2 chamadas em "POST /orcamentos/{n}/cobrar"
    Quando o serviço "Billing" envia o callback "billing.pagamento-aprovado" para a OS
    Então a OS fica com status "FINALIZADA"

  @cancelamento
  Esquema do Cenário: Atendente cancela a OS antes da aprovação (<status>)
    Dado que existe uma OS no status "<status>"
    Quando o atendente cancela a OS
    Então a resposta tem status HTTP 200
    E a OS é cancelada com o motivo "OPERADOR"
    E a saga fica no passo "<passo>" com status "CANCELADA"
    E as compensações confirmadas da saga são "<compensacoes>"
    # Próxima etapa (US-F4-12): notificação "OS_CANCELADA".

    Exemplos:
      | status               | passo                | compensacoes                                         |
      | EM_DIAGNOSTICO       | AGUARDAR_DIAGNOSTICO | execucao.liberar-reservas                            |
      | AGUARDANDO_APROVACAO | AGUARDAR_APROVACAO   | billing.cancelar-orcamento, execucao.liberar-reservas |

  @cancelamento
  Cenário: Cancelar depois que a execução começou é recusado
    Dado que existe uma OS no status "EM_EXECUCAO"
    Quando o atendente cancela a OS
    Então a resposta tem status HTTP 400
    E a OS permanece com status "EM_EXECUCAO"
    E o serviço "Billing" não recebeu chamadas em "DELETE /orcamentos/{n}"

  @falha-plataforma
  Cenário: Execução fora do ar na abertura deixa a saga parada até o reprocessamento
    Dado que o serviço "Execução" está fora do ar em "POST /execucao/ordens"
    Quando o atendente abre uma OS para o veículo
    Então a OS fica com status "RECEBIDA"
    E a saga fica no passo "ENFILEIRAR_EXECUCAO" com status "EM_ANDAMENTO"
    E o serviço "Execução" recebeu 3 chamadas em "POST /execucao/ordens"

    Quando o serviço "Execução" volta ao ar
    E o administrador reprocessa a saga
    Então a OS fica com status "EM_DIAGNOSTICO"
    E a saga fica no passo "AGUARDAR_DIAGNOSTICO" com status "EM_ANDAMENTO"

  @falha-plataforma
  Esquema do Cenário: Participante responde 5xx, a saga para em <passo parado> e o reprocessamento segue
    Dado que existe uma OS no status "<status inicial>"
    E que o serviço "<participante>" responde 503 em "<rota>"
    Quando o serviço "<remetente>" envia o callback "<callback>" para a OS
    Então o callback é aplicado
    E a saga fica no passo "<passo parado>" com status "EM_ANDAMENTO"
    E a OS permanece com status "<status parado>"
    E a saga não tem compensações

    Quando o serviço "<participante>" volta ao ar
    E o administrador reprocessa a saga
    Então a OS fica com status "<status final>"
    E a saga fica no passo "<passo final>" com status "EM_ANDAMENTO"

    # Na cobrança a OS já vai para AGUARDANDO_PAGAMENTO com o callback execucao.finalizada;
    # o que fica pendente é só a chamada POST /orcamentos/{n}/cobrar (passo COBRAR).
    Exemplos:
      | status inicial       | participante | rota                              | remetente | callback                        | passo parado     | status parado        | status final         | passo final          |
      | EM_DIAGNOSTICO       | Billing      | POST /orcamentos                  | Execução  | execucao.diagnostico-concluido  | GERAR_ORCAMENTO  | EM_DIAGNOSTICO       | AGUARDANDO_APROVACAO | AGUARDAR_APROVACAO   |
      | AGUARDANDO_APROVACAO | Execução     | POST /execucao/ordens/{n}/iniciar | Billing   | billing.orcamento-aprovado      | INICIAR_EXECUCAO | AGUARDANDO_APROVACAO | EM_EXECUCAO          | AGUARDAR_FINALIZACAO |
      | EM_EXECUCAO          | Billing      | POST /orcamentos/{n}/cobrar       | Execução  | execucao.finalizada             | COBRAR           | AGUARDANDO_PAGAMENTO | AGUARDANDO_PAGAMENTO | AGUARDAR_PAGAMENTO   |

  @idempotencia
  Esquema do Cenário: Callback duplicado (mesmo id) não duplica o efeito — <callback>
    Dado que existe uma OS no status "<status inicial>"
    Quando o serviço "<remetente>" envia o callback "<callback>" para a OS
    E o serviço "<remetente>" reenvia o mesmo callback
    Então o callback é reconhecido como duplicado e não é reaplicado
    E o serviço "<participante>" recebeu 1 chamada em "<rota>"
    E a OS fica com status "<status final>"

    Exemplos:
      | status inicial       | remetente | callback                       | participante | rota                              | status final         |
      | EM_DIAGNOSTICO       | Execução  | execucao.diagnostico-concluido | Billing      | POST /orcamentos                  | AGUARDANDO_APROVACAO |
      | AGUARDANDO_APROVACAO | Billing   | billing.orcamento-aprovado     | Execução     | POST /execucao/ordens/{n}/iniciar | EM_EXECUCAO          |
      | EM_EXECUCAO          | Execução  | execucao.finalizada            | Billing      | POST /orcamentos/{n}/cobrar       | AGUARDANDO_PAGAMENTO |

  @idempotencia
  Cenário: Diagnóstico duplicado não gera um segundo orçamento nem uma segunda notificação
    Dado que existe uma OS no status "EM_DIAGNOSTICO"
    Quando o serviço "Execução" envia o callback "execucao.diagnostico-concluido" para a OS
    E o serviço "Execução" reenvia o mesmo callback
    Então o callback é reconhecido como duplicado e não é reaplicado
    E o cliente recebe 1 notificação "ORCAMENTO_PRONTO"
