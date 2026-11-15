import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import html
W,H=1920,1080
out=[]
def esc(s): return html.escape(s)
def box(x,y,w,h,fill,stroke,dash=False,rx=10,sw=2):
    d=' stroke-dasharray="8 6"' if dash else ''
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
def text(x,y,lines,size=18,weight="normal",anchor="middle",color="#1f1f1f",lh=None):
    lh=lh or int(size*1.3)
    if isinstance(lines,str): lines=[lines]
    y0=y-(len(lines)-1)*lh/2
    for i,l in enumerate(lines):
        w=weight
        if l.startswith('**') and l.endswith('**'): l=l[2:-2]; w='bold'
        out.append(f'<text x="{x}" y="{y0+i*lh}" font-size="{size}" font-weight="{w}" text-anchor="{anchor}" dominant-baseline="middle" fill="{color}">{esc(l)}</text>')
def label(x,y,s,size=15):
    tw=len(s)*size*0.56+14
    out.append(f'<rect x="{x-tw/2}" y="{y-13}" width="{tw}" height="26" rx="5" fill="#ffffff" stroke="#bfbfbf"/>')
    text(x,y,s,size=size,color="#434343")
def node(x,y,w,h,lines,fill,stroke,size=17):
    box(x,y,w,h,fill,stroke); text(x+w/2,y+h/2,lines,size=size)
def cyl(x,y,w,h,lines,fill="#f6ffed",stroke="#389e0d"):
    e=14
    out.append(f'<path d="M{x},{y+e} a{w/2},{e} 0 0,0 {w},0 a{w/2},{e} 0 0,0 {-w},0 v{h-2*e} a{w/2},{e} 0 0,0 {w},0 v{-(h-2*e)}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
    text(x+w/2,y+h/2+6,lines,size=17)
def arrow(pts,color="#262626",dash=False,width=2.4,both=False):
    d=' stroke-dasharray="7 6"' if dash else ''
    p=" ".join(f"{a},{b}" for a,b in pts)
    ms=' marker-start="url(#ah-s)"' if both else ''
    out.append(f'<polyline points="{p}" fill="none" stroke="{color}" stroke-width="{width}"{d} marker-end="url(#ah)"{ms}/>')

out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Inter, Helvetica Neue, Arial, sans-serif">')
out.append('<defs><marker id="ah" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="#262626"/></marker><marker id="ah-s" markerWidth="9" markerHeight="9" refX="1" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M9,0 L0,4.5 L9,9 z" fill="#262626"/></marker></defs>')
out.append(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(960,42,"Infraestrutura da Fase 4: o que fica fora e dentro da VPC",size=32,weight="bold")

# ---- fora da AWS
box(30,90,300,960,"#fffbf0","#d48806",dash=True)
text(180,118,"Fora da AWS",size=20,weight="bold",color="#874d00")
node(55,160,250,110,["**web/admin**","atendente · mecânico","gestor"],"#fff7e6","#d48806")
node(55,300,250,90,["**web/cliente**","cliente (só CPF)"],"#fff7e6","#d48806")
node(55,470,250,110,["**Mercado Pago**","checkout (API de Orders)","webhook assinado"],"#fff7e6","#d48806")
node(55,800,250,110,["**Datadog (SaaS)**","APM · logs · métricas","dashboards e alertas"],"#fff7e6","#d48806")

# ---- AWS
box(370,90,1520,960,"#fcfcfc","#595959",rx=14)
text(470,118,"AWS · us-east-1",size=20,weight="bold",color="#262626")
# borda e regionais (fora da VPC)
node(400,150,420,120,["**API Gateway (HTTP API)**","única entrada pública · JWT (authorizer)","rotas por prefixo · throttling · access logs"],"#f9f0ff","#722ed1")
box(1120,140,740,140,"#f5f5f5","#8c8c8c",dash=True)
text(1490,162,"Serviços regionais (fora da VPC)",size=17,weight="bold",color="#434343")
node(1140,185,160,80,["Secrets","Manager"],"#ffffff","#8c8c8c",size=16)
node(1315,185,120,80,["ECR"],"#ffffff","#8c8c8c",size=16)
node(1450,185,160,80,["CloudWatch","logs da borda"],"#ffffff","#8c8c8c",size=16)
cyl(1625,180,215,92,["DynamoDB","4 tabelas oficina-*"])

# ---- VPC
box(400,310,1460,720,"#f0f7ff","#1677ff",rx=14)
text(1000,336,"VPC 10.0.0.0/16 · 2 AZs",size=20,weight="bold",color="#0958d9")
# públicas
box(1590,370,250,190,"#e6fffb","#08979c",dash=True)
text(1715,392,"Subnets públicas",size=16,weight="bold",color="#006d75")
node(1605,410,220,135,["**NAT + Internet Gateway**","saída da VPC: ECR,","Secrets, Datadog,","Mercado Pago"],"#ffffff","#08979c",size=15)
node(1590,780,250,110,["**VPC Gateway**","**Endpoint · DynamoDB**","política: oficina-*"],"#ffffff","#389e0d",size=16)
# privadas
box(425,370,1140,640,"#ffffff","#1677ff",dash=True)
text(1000,394,"Subnets privadas",size=17,weight="bold",color="#0958d9")
node(450,430,260,120,["**VPC Link →**","**NLB interno**","1 listener por serviço"],"#f9f0ff","#722ed1")
node(450,650,260,120,["**Lambda de CPF**","emite o JWT","(ENIs na VPC)"],"#f9f0ff","#722ed1")
# EKS
box(750,420,500,560,"#f6ffed","#52c41a",rx=12)
text(1000,446,"EKS · namespace oficina",size=18,weight="bold",color="#237804")
node(780,475,440,105,["**OS Service**","OS, clientes, veículos · orquestrador da saga"],"#e6f4ff","#1677ff")
node(780,640,205,110,["**Execução**","fila, diagnóstico,","catálogo e estoque"],"#e6f4ff","#1677ff",size=16)
node(1015,640,205,110,["**Billing**","orçamento e","pagamento"],"#e6f4ff","#1677ff",size=16)
node(780,880,440,75,["Datadog Agent (DaemonSet) · logs, métricas e traces"],"#fff7e6","#d48806",size=16)
# RDS
cyl(1300,470,235,115,["**RDS PostgreSQL**","do OS"])
cyl(1300,640,235,115,["**RDS PostgreSQL**","do Billing"])

# ---- setas
arrow([(305,215),(350,215),(350,190),(400,190)]); label(352,140,"HTTPS + JWT",14)
arrow([(305,345),(350,345),(350,240),(400,240)])
arrow([(305,525),(370,525),(370,258),(400,258)],dash=True); label(345,600,"webhook",14)
arrow([(580,270),(580,430)]); label(640,300,"VPC Link",14)
arrow([(450,262),(438,262),(438,710),(450,710)],dash=True); label(500,615,"POST /auth",14)
arrow([(710,490),(780,520)]); label(735,595,"rotas por prefixo",14)
arrow([(895,580),(880,640)],both=True); arrow([(1105,580),(1117,640)],both=True)
label(1000,612,"comandos HTTP ⇄ callbacks (DNS interno)",14)
arrow([(1220,527),(1300,527)])
arrow([(1220,697),(1300,697)])
arrow([(580,770),(580,1000),(1560,1000),(1560,527),(1535,527)],dash=True); label(1000,1000,"Lambda consulta o CPF no banco do OS",14)
arrow([(882,750),(882,820),(1575,820),(1575,835),(1590,835)]); label(1240,820,"Execução → DynamoDB sem sair para a internet",14)
arrow([(1840,835),(1872,835),(1872,226),(1840,226)])
arrow([(1220,917),(1580,917),(1580,500),(1605,500)],dash=True); label(1400,917,"saída via NAT",14)
out.append('</svg>')
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '11-infra-slide.svg'),'w').write("\n".join(out))
