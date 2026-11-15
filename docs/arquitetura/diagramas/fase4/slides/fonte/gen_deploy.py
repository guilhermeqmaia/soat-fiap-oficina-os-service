import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import Slide
S=Slide(title="Deploy automatizado: um pipeline independente por serviço")
S.text(960,92,"os-service, billing-service e execucao-service: cada repositório com o próprio CI/CD, imagem no ECR e deployment no EKS",size=19,color="#434343")
# 1 PR
S.node(40,140,270,330,["**1 · Pull request**","","main protegida:","PR obrigatório","1 aprovação","checks obrigatórios","sem push direto"],"#fff7e6","#d48806",size=19)
S.arrow([(310,305),(350,305)])
# 2 CI
S.box(350,140,560,330,"#f6ffed","#389e0d",rx=12)
S.text(630,170,"2 · CI no PR (GitHub Actions)",size=21,weight="bold",color="#237804")
checks=[("Lint, typecheck e testes","unitários + integração · gate de 80%"),("BDD · Cucumber","cenários Gherkin em português"),("SonarCloud","quality gate bloqueante"),("Build da imagem Docker","")]
y=200
for a,b in checks:
    S.node(375,y,510,58,[f"**✔ {a}**"]+([b] if b else []),"#ffffff","#389e0d",size=17)
    y+=66
S.arrow([(910,305),(950,305)])
# 3 merge
S.node(950,230,190,150,["**3 · Merge**","na main","dispara o CD"],"#f9f0ff","#722ed1",size=19)
S.arrow([(1140,305),(1180,305)])
# 4 CD
S.box(1180,140,700,700,"#e6f4ff","#1677ff",rx=12)
S.text(1530,170,"4 · CD (cd-aws.yml)",size=21,weight="bold",color="#0958d9")
steps=[("Credenciais AWS por OIDC","sem chave guardada no GitHub"),("Build da imagem",""),("Trivy","bloqueia vulnerabilidade CRITICAL"),("Push no ECR","tag = commit"),("Secrets Manager → Secret no cluster","JWT, banco, Mercado Pago"),("kustomize (overlay k8s-aws) + apply","migrations em Job (serviços com Postgres)"),("Rollout + smoke test","/health e /health/ready"),("NodePort publicado para o NLB","o API Gateway já enxerga a versão nova")]
y=198
for i,(a,b) in enumerate(steps):
    S.node(1205,y,650,62,[f"**{a}**"]+([b] if b else []),"#ffffff","#1677ff",size=17)
    if i<len(steps)-1: S.arrow([(1530,y+62),(1530,y+76)])
    y+=78
# EKS alvo
S.node(40,520,1110,150,["**EKS · namespace oficina**","OS Service · Execução · Billing — Deployment com HPA, PodDisruptionBudget e Service NodePort","rolling update: a versão anterior só sai quando a nova responde no /health"],"#f0f5ff","#2f54eb",size=19)
S.arrow([(1180,780),(1100,780),(1100,670)])
S.label(1140,800,"deploy",size=15)
# infra
S.box(40,720,1040,320,"#fafafa","#8c8c8c",rx=12)
S.text(560,752,"Infraestrutura também por pipeline (Terraform)",size=21,weight="bold",color="#262626")
infra=[("infra-k8s","VPC, EKS, API Gateway,","VPC Endpoint, Datadog"),("infra-db","RDS do OS, RDS do Billing,","tabelas DynamoDB"),("auth-lambda","Lambda de CPF","e authorizer")]
x=65
for a,b,c in infra:
    S.node(x,785,315,130,[f"**{a}**",b,c],"#ffffff","#8c8c8c",size=18)
    x+=335
S.text(560,975,"plan comentado no PR · apply no merge da main · state no S3 com lock",size=19,color="#434343")
S.text(560,1010,"mesma proteção de branch e credenciais por OIDC",size=19,color="#434343")
S.node(1180,870,700,170,["**Resultado**","um serviço sobe sozinho, sem parar os outros","nada vai para produção sem testes, BDD","e quality gate verdes"],"#f6ffed","#389e0d",size=19)
S.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '13-deploy.svg'))
