# OpenAPI por serviço

Cada serviço exporta o seu OpenAPI 3 a partir do Swagger do NestJS e publica aqui
([US-F4-15](../../user-stories/f4-15-testes-de-contrato.md)). Esta pasta é a fonte
dos testes de contrato no CI de cada serviço e a referência para quem consome a API.

| Arquivo | Serviço | Repositório | Status |
|---|---|---|---|
| `os-service.yaml` | OS Service (`/ordens-servico`, `/clientes`, `/veiculos`, `/usuario`, `/notificacoes`, `/auth/me`, `/admin`, callback `/ordens-servico/{numero}/eventos`) | `soat-fiap-oficina-os-service` | *placeholder — a publicar* |
| `billing-service.yaml` | Billing (`/orcamentos`, `/pagamentos`, `/webhooks/mercadopago`) | `soat-fiap-oficina-billing-service` | *placeholder — a publicar* |
| `execucao-service.yaml` | Execução (`/execucao`, `/catalogo`, `/estoque`) | `soat-fiap-oficina-execucao-service` | *placeholder — a publicar* |

Regras:

- Os endpoints internos (`SERVICO`) e o callback seguem [`../http-interno.md`](../http-interno.md);
  os schemas de `data` do envelope vêm do [`../asyncapi.yaml`](../asyncapi.yaml).
- `info.version` = versão do serviço; campo novo opcional = minor; remoção/renomeação/mudança
  de código de resposta = major + rota versionada.
- Validar: `npx -y @redocly/cli lint docs/contratos/openapi/<servico>.yaml`.
- Renderizar: `npx -y @redocly/cli build-docs docs/contratos/openapi/<servico>.yaml -o docs/contratos/html/<servico>.html`.
