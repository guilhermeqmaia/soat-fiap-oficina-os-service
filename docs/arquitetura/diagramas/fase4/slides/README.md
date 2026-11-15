# Slides da apresentação da Fase 4 (16:9)

Imagens prontas para o vídeo, em 1920x1080 ou próximo disso. A ordem segue o roteiro da seção 8 do
[documento de entrega](../../../../entrega-fase-4.md).

| Arquivo | Seção do vídeo | Origem |
|---|---|---|
| `11-infra-slide.png` | Infraestrutura: o que fica fora e dentro da VPC | SVG desenhado à mão (`fonte/gen_infra.py`) |
| `09-fluxo-os-por-ator.png` | Fluxo de uma OS: quem age e qual sistema processa cada passo | Mermaid, seção 3.6 de [`arquitetura-fase4.md`](../../../arquitetura-fase4.md) |
| `12-saga-falhas.png` | Saga orquestrada e os três tipos de falha | SVG (`fonte/gen_saga.py`) |
| `13-deploy.png` | Deploy automatizado por serviço | SVG (`fonte/gen_deploy.py`) |
| `10-observabilidade.png` | Monitoramento e rastreamento | Mermaid, seção 5 de [`arquitetura-fase4.md`](../../../arquitetura-fase4.md) |

Apoio, se sobrar tempo: `../06-compensacao-rejeicao.png` (sequência da compensação) e `../02-rede-vpc.png` (rede em detalhe).

## Regenerar

```bash
cd docs/arquitetura/diagramas/fase4/slides/fonte
python3 gen_infra.py && python3 gen_saga.py && python3 gen_deploy.py      # gera ../*.svg
for s in 11-infra-slide 12-saga-falhas 13-deploy; do
  npx -y -p puppeteer node render.cjs "$PWD/../$s.svg" "$PWD/../$s.png" 1920 1080
done
```

Os SVGs usam posições fixas (o Mermaid não respeita raias e direções quando as setas cruzam grupos).
Todo texto foi conferido com o Terraform e os workflows dos repositórios em 15/11/2026.
