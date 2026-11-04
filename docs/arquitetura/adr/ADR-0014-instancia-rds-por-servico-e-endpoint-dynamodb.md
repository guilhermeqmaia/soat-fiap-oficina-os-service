# ADR-0014: Uma instância RDS por serviço e VPC Endpoint para o DynamoDB

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

A decisão D10 do [plano da Fase 4](../../plano-execucao-fase-4.md) previa **uma
instância RDS** com dois bancos lógicos (`oficina_mecanica` para o OS Service e
`oficina_billing` para o Billing) e usuários exclusivos, por custo. O isolamento
era real no Postgres (cada usuário só tem `CONNECT` no próprio banco), mas na
entrega "um banco por serviço" dependeria de explicar grants, e qualquer pessoa
com a senha mestre da instância enxergaria os dois bancos.

O DynamoDB da Execução, por ser um serviço regional, era acessado pelos nodes
do EKS via **NAT Gateway** e endpoint público, enquanto o RDS vive em subnet
privada. O time questionou a assimetria: por que o NoSQL fica "fora" da VPC?

## Decisão

1. **Uma instância RDS por serviço com banco relacional.** A instância existente
   continua sendo a do OS Service (sem mudança de contrato para o CD). Cada
   entrada de `service_databases` no repo `infra-db` cria **a própria
   instância** (`oficina-mecanica-billing`), com security group e segredo
   próprios. O bootstrap SQL (`CREATE DATABASE`/`ROLE` via Job no EKS) deixa de
   existir: o usuário mestre de cada instância é o usuário do serviço.
2. **VPC Gateway Endpoint para o DynamoDB** no stage `cluster/` do repo
   `infra-k8s`, nas route tables das subnets privadas, com **política do
   endpoint** restrita à tabela `oficina-execucao` e seus índices. O tráfego da
   Execução para o DynamoDB não passa mais pelo NAT nem pela internet.

## Consequências

- Isolamento por **instância** e por **rede**: o segredo de cada serviço só
  contém o próprio host; o SG de cada instância só aceita os nodes; não há
  caminho de um serviço ao banco do outro, nem com credenciais vazadas de um
  deles.
- Custo: mais uma `db.t3.micro` (cerca de US$ 13/mês em single-AZ; Multi-AZ
  dobra). Aceitável porque a infra é efêmera ([ADR-0008](ADR-0008-ambiente-efemero.md)).
- O endpoint de gateway é **gratuito** e reduz o tráfego pago do NAT.
- O DynamoDB continua um serviço regional: ele não "entra" na VPC como o RDS;
  o endpoint é o equivalente de segurança (acesso só a partir da VPC, só à
  tabela da Execução). A tabela em si segue no repo `infra-db`.
- Diagramas e textos: [arquitetura-fase4.md](../arquitetura-fase4.md),
  [US-F4-03](../../user-stories/f4-03-bancos-por-servico.md), plano (D10).

## Alternativas descartadas

- **Manter instância única com grants** (decisão original): mais barata, mas
  ambígua na avaliação e com um único ponto de acesso administrativo aos dois
  bancos.
- **Interface endpoint (PrivateLink) para o DynamoDB:** custa por hora e por AZ;
  o endpoint de gateway resolve o mesmo problema sem custo.
- **Aurora Serverless v2 compartilhado com dois clusters lógicos:** mais caro
  que duas `t3.micro` para a carga de demo.
