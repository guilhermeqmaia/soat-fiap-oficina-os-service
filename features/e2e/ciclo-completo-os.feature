# language: pt
# US-F4-14 — FLUXO 3 ponta a ponta: o ciclo completo da OS contra o docker-compose.fase4.yml
# (os-service + Postgres, billing-service:3001, execucao-service:3002, Mailpit), só por HTTP.
#
#   npm run e2e:up && npm run test:bdd:e2e && npm run e2e:down
#
# As ações das pessoas acontecem no serviço dono delas (o mecânico diagnostica na Execução,
# o cliente aprova no Billing) e o participante envia o callback ao OS Service. Billing e
# Execução são os stubs de e2e/stubs por padrão (seguem docs/contratos/http-interno.md e
# validam tudo contra docs/contratos/schemas — qualquer divergência reprova o cenário).
# @stub = usa /__stub/* (cenário controlado, Mercado Pago simulado); com as imagens reais
# (BDD_E2E_REAIS=1) esses cenários são pulados.

@e2e @fluxo-3
Funcionalidade: Ciclo completo da Ordem de Serviço entre OS Service, Execução e Billing
  Como atendente da oficina
  Quero que a OS percorra Execução e Billing sozinha, do diagnóstico à entrega
  Para que o cliente seja avisado em cada marco e cobrado só depois do serviço feito

  Contexto:
    Dado que existe um cliente com veículo

  @caminho-feliz @stub
  Cenário: Caminho feliz da abertura à entrega do veículo
    Quando o atendente abre uma OS para o veículo
    Então a OS fica com status "EM_DIAGNOSTICO"
    E o serviço "Execução" registra a OS com status "NA_FILA"
    E o serviço "Execução" recebeu a chamada "POST /execucao/ordens" com o JWT de serviço do OS Service

    Quando o mecânico conclui o diagnóstico na Execução
    Então o callback é aplicado
    E a OS fica com status "AGUARDANDO_APROVACAO"
    E o serviço "Billing" registra a OS com status "PENDENTE"
    E o serviço "Billing" recebeu a chamada "POST /orcamentos" com o JWT de serviço do OS Service
    E o cliente recebe o e-mail "pronto para aprovacao" no Mailpit

    Quando o cliente aprova o orçamento no Billing
    Então o callback é aplicado
    E a OS fica com status "EM_EXECUCAO"
    E o serviço "Execução" registra a OS com status "EM_EXECUCAO"
    E o cliente recebe o e-mail "aprovado" no Mailpit

    Quando o mecânico finaliza a execução
    Então o callback é aplicado
    E a OS fica com status "AGUARDANDO_PAGAMENTO"
    E o serviço "Billing" recebeu 1 chamada em "POST /orcamentos/{n}/cobrar"
    E o cliente recebe a notificação "PAGAMENTO_PENDENTE" com o link de pagamento
    E o e-mail "pague para retirar" no Mailpit traz o link de pagamento do Billing

    Quando o cliente paga a cobrança
    Então o callback é aplicado
    E a OS fica com status "FINALIZADA"
    E a saga fica no passo "CONCLUIDA" com status "CONCLUIDA"
    E a saga não tem compensações
    E o serviço "Billing" registra a OS com status "PAGO"
    E o cliente recebe o e-mail "confirmado" no Mailpit
    E o cliente recebe o e-mail "pronto para retirada" no Mailpit

    Quando o atendente entrega o veículo
    Então a resposta tem status HTTP 200
    E a OS fica com status "ENTREGUE"
    E o histórico de notificações da OS lista "ORCAMENTO_PRONTO, ORCAMENTO_APROVADO, PAGAMENTO_PENDENTE, PAGAMENTO_APROVADO, OS_FINALIZADA"
    E as métricas do OS Service aumentaram:
      | métrica                   | labels                                                                       | aumento |
      | oficina_callbacks_total   | type="execucao.diagnostico-concluido",resultado="aplicado"                   | 1       |
      | oficina_callbacks_total   | type="billing.orcamento-aprovado",resultado="aplicado"                       | 1       |
      | oficina_callbacks_total   | type="execucao.finalizada",resultado="aplicado"                              | 1       |
      | oficina_callbacks_total   | type="billing.pagamento-aprovado",resultado="aplicado"                       | 1       |
      | oficina_http_interno_total | destino="execucao-service",rota="POST /execucao/ordens",resultado="sucesso" | 1       |
      | oficina_http_interno_total | destino="billing-service",rota="POST /orcamentos",resultado="sucesso"       | 1       |
      | oficina_http_interno_total | rota="POST /execucao/ordens/{numero}/iniciar",resultado="sucesso"           | 1       |
      | oficina_http_interno_total | rota="POST /orcamentos/{numero}/cobrar",resultado="sucesso"                 | 1       |

  @compensacao
  Cenário: Cliente rejeita o orçamento e a Execução libera as reservas
    Dado que existe uma OS no status "AGUARDANDO_APROVACAO"
    Quando o cliente rejeita o orçamento no Billing
    Então o callback é aplicado
    E a OS é cancelada com o motivo "ORCAMENTO_REJEITADO"
    E a saga fica no passo "AGUARDAR_APROVACAO" com status "CANCELADA"
    E as compensações confirmadas da saga são "execucao.liberar-reservas"
    E o serviço "Execução" registra a OS com status "LIBERADA"
    E o serviço "Execução" não recebeu chamadas em "POST /execucao/ordens/{n}/iniciar"
    E o serviço "Billing" registra a OS com status "REJEITADO"
    E o cliente recebe o e-mail "cancelada" no Mailpit
    E as métricas do OS Service aumentaram:
      | métrica                    | labels                                                         | aumento |
      | oficina_callbacks_total    | type="billing.orcamento-rejeitado",resultado="aplicado"        | 1       |
      | oficina_http_interno_total | rota="DELETE /execucao/ordens/{numero}",resultado="sucesso"    | 1       |

  @pagamento @stub
  Cenário: Pagamento recusado mantém a OS aguardando pagamento e o reprocessamento gera nova cobrança
    Dado que existe uma OS no status "AGUARDANDO_PAGAMENTO"
    E que o Mercado Pago vai recusar o próximo pagamento
    Quando o cliente paga a cobrança
    Então o callback é aplicado
    E a OS permanece com status "AGUARDANDO_PAGAMENTO"
    E o histórico da saga termina com "billing.pagamento-recusado" e resultado "pagamento-pendente"
    E a saga não tem compensações
    E o cliente recebe a notificação "PAGAMENTO_RECUSADO" mencionando "cartao recusado"
    E o cliente recebe o e-mail "recusado" no Mailpit

    Quando o administrador reprocessa a saga
    Então o serviço "Billing" recebeu 2 chamadas em "POST /orcamentos/{n}/cobrar"
    E o Billing emitiu 2 cobranças com links diferentes
    E o cliente recebe 2 e-mails "pague para retirar" no Mailpit

    Quando o cliente paga a cobrança
    Então a OS fica com status "FINALIZADA"
    E o cliente recebe o e-mail "confirmado" no Mailpit
    E as métricas do OS Service aumentaram:
      | métrica                 | labels                                                   | aumento |
      | oficina_callbacks_total | type="billing.pagamento-recusado",resultado="aplicado"   | 1       |
      | oficina_callbacks_total | type="billing.pagamento-aprovado",resultado="aplicado"   | 1       |

  @cancelamento
  Esquema do Cenário: Atendente cancela a OS em <status> e os participantes compensam
    Dado que existe uma OS no status "<status>"
    Quando o atendente cancela a OS
    Então a resposta tem status HTTP 200
    E a OS é cancelada com o motivo "OPERADOR"
    E as compensações confirmadas da saga são "<compensacoes>"
    E o serviço "Execução" registra a OS com status "LIBERADA"
    E o serviço "Billing" recebeu <deletes billing> chamada em "DELETE /orcamentos/{n}"
    E o cliente recebe o e-mail "cancelada" no Mailpit

    Exemplos:
      | status               | compensacoes                                          | deletes billing |
      | EM_DIAGNOSTICO       | execucao.liberar-reservas                             | 0               |
      | AGUARDANDO_APROVACAO | billing.cancelar-orcamento, execucao.liberar-reservas | 1               |

  @cancelamento
  Cenário: Cancelar depois que a execução começou é recusado e nada é compensado
    Dado que existe uma OS no status "EM_EXECUCAO"
    Quando o atendente cancela a OS
    Então a resposta tem status HTTP 400
    E a OS permanece com status "EM_EXECUCAO"
    E o serviço "Execução" registra a OS com status "EM_EXECUCAO"
    E o serviço "Billing" não recebeu chamadas em "DELETE /orcamentos/{n}"

  @falha-plataforma @stub
  Cenário: Billing responde 5xx até esgotar o retry, a saga para e o reprocessamento segue
    Dado que existe uma OS no status "EM_DIAGNOSTICO"
    E que o serviço "Billing" responde 5xx nas próximas 3 chamadas em "POST /orcamentos"
    Quando o mecânico conclui o diagnóstico na Execução
    Então o callback é aplicado
    E a saga fica no passo "GERAR_ORCAMENTO" com status "EM_ANDAMENTO"
    E a OS permanece com status "EM_DIAGNOSTICO"
    E o serviço "Billing" recebeu 3 chamadas em "POST /orcamentos"
    E o histórico da saga registra o comando "billing.gerar-orcamento" não entregue após 3 tentativas
    E as métricas do OS Service aumentaram:
      | métrica                    | labels                                          | aumento |
      | oficina_http_interno_total | rota="POST /orcamentos",resultado="esgotado"    | 1       |

    Quando o administrador reprocessa a saga
    Então a OS fica com status "AGUARDANDO_APROVACAO"
    E a saga fica no passo "AGUARDAR_APROVACAO" com status "EM_ANDAMENTO"
    E o serviço "Billing" recebeu 4 chamadas em "POST /orcamentos"
    E o cliente recebe 1 e-mail "pronto para aprovacao" no Mailpit

  @falha-plataforma @stub
  Cenário: 5xx transitório é absorvido pelo retry do cliente HTTP, sem reprocessar
    Dado que existe uma OS no status "EM_EXECUCAO"
    E que o serviço "Billing" responde 5xx nas próximas 2 chamadas em "POST /orcamentos/{n}/cobrar"
    Quando o mecânico finaliza a execução
    Então a OS fica com status "AGUARDANDO_PAGAMENTO"
    E a saga fica no passo "AGUARDAR_PAGAMENTO" com status "EM_ANDAMENTO"
    E o serviço "Billing" recebeu 3 chamadas em "POST /orcamentos/{n}/cobrar"
    E as métricas do OS Service aumentaram:
      | métrica                    | labels                                                      | aumento |
      | oficina_http_interno_total | rota="POST /orcamentos/{numero}/cobrar",resultado="sucesso" | 1       |
      | oficina_http_interno_total | rota="POST /orcamentos/{numero}/cobrar",resultado="esgotado" | 0      |

  @falha-plataforma @stub
  Cenário: Execução fora do ar na abertura deixa a OS em RECEBIDA até o reprocessamento
    Dado que o serviço "Execução" está fora do ar em "POST /execucao/ordens"
    Quando o atendente abre uma OS para o veículo
    Então a OS fica com status "RECEBIDA"
    E a saga fica no passo "ENFILEIRAR_EXECUCAO" com status "EM_ANDAMENTO"
    E o serviço "Execução" recebeu 3 chamadas em "POST /execucao/ordens"

    Quando o serviço "Execução" volta ao ar
    E o administrador reprocessa a saga
    Então a OS fica com status "EM_DIAGNOSTICO"
    E o serviço "Execução" registra a OS com status "NA_FILA"

  @idempotencia @stub
  Cenário: Callback reenviado com o mesmo id não duplica orçamento, notificação nem e-mail
    Dado que existe uma OS no status "EM_DIAGNOSTICO"
    Quando o mecânico conclui o diagnóstico na Execução
    E o serviço "Execução" reenvia o mesmo callback
    Então o callback é reconhecido como duplicado e não é reaplicado
    E o serviço "Billing" recebeu 1 chamada em "POST /orcamentos"
    E o cliente recebe 1 notificação "ORCAMENTO_PRONTO"
    E o cliente recebe 1 e-mail "pronto para aprovacao" no Mailpit
    E as métricas do OS Service aumentaram:
      | métrica                 | labels                                                       | aumento |
      | oficina_callbacks_total | type="execucao.diagnostico-concluido",resultado="aplicado"   | 1       |
      | oficina_callbacks_total | type="execucao.diagnostico-concluido",resultado="duplicado"  | 1       |

  @idempotencia @stub
  Cenário: Pagamento aprovado reenviado não confirma o pagamento duas vezes
    Dado que existe uma OS no status "AGUARDANDO_PAGAMENTO"
    Quando o cliente paga a cobrança
    E o serviço "Billing" reenvia o mesmo callback
    Então o callback é reconhecido como duplicado e não é reaplicado
    E a OS fica com status "FINALIZADA"
    E o cliente recebe 1 e-mail "confirmado" no Mailpit

  @idempotencia @stub
  Cenário: POST /execucao/ordens repetido não duplica a fila
    Quando o atendente abre uma OS para o veículo
    E a OS fica com status "EM_DIAGNOSTICO"
    E o OS Service pede de novo à Execução para enfileirar a OS
    Então a Execução devolve a mesma posição na fila, sem duplicar a ordem
