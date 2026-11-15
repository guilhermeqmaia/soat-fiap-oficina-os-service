import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import Slide
S=Slide(title="Saga orquestrada no OS Service e tratamento de falhas")
# legenda participantes
EXc=("#f6ffed","#389e0d"); BIc=("#f9f0ff","#722ed1"); OSc=("#e6f4ff","#1677ff")
S.text(960,92,"O orquestrador guarda o estado em saga_os e, a cada passo, manda um comando HTTP ou espera um callback",size=19,color="#434343")
passos=[("ENFILEIRAR","EXECUCAO","Execução","cmd",EXc),("AGUARDAR","DIAGNOSTICO","mecânico","esp",EXc),("GERAR","ORCAMENTO","Billing","cmd",BIc),("AGUARDAR","APROVACAO","cliente","esp",BIc),
        ("INICIAR","EXECUCAO","Execução","cmd",EXc),("AGUARDAR","FINALIZACAO","mecânico","esp",EXc),("COBRAR","","Billing → MP","cmd",BIc),("AGUARDAR","PAGAMENTO","cliente","esp",BIc)]
x=40; w=208; g=26; y=135
for i,(a,b,quem,t,(f,st)) in enumerate(passos):
    S.box(x,y,w,108,f,st,dash=(t=="esp"))
    S.text(x+w/2,y+32,[a,b] if b else [a],size=17,weight="bold")
    S.text(x+w/2,y+84,("comando → " if t=="cmd" else "espera: ")+quem,size=15,color="#434343")
    if i<len(passos)-1: S.arrow([(x+w,y+54),(x+w+g,y+54)])
    x+=w+g
S.text(1890,189,"",size=1)
S.arrow([(1782,243),(1782,266)])
S.label(1782,282,"saga CONCLUIDA",size=16,color="#237804",border="#389e0d")
S.text(40,282,"caixa cheia = comando automático · tracejada = espera por pessoa",size=15,color="#595959",anchor="start")

# tres colunas de falha
cols=[
 ("1 · Falha de negócio antes da execução","#fff1f0","#cf1322",
  ["veículo já em execução · orçamento rejeitado","prazo de aprovação vencido · cancelamento"],
  ["saga entra em **COMPENSANDO**","→ billing.cancelar-orcamento","→ execucao.liberar-reservas","   (devolve ao estoque as peças baixadas)","OS **CANCELADA** com o motivo"]),
 ("2 · Falha técnica (serviço fora, timeout, 5xx)","#fff7e6","#d48806",
  ["participante não responde ao comando"],
  ["retry com backoff: 200 ms, 800 ms, 3 s","esgotou → falha pendente, saga parada","alerta \"saga de OS parada\" (Datadog)","operador: POST /admin/sagas/{n}/reprocessar","→ mesmo comando, de novo (idempotente)"]),
 ("3 · Pagamento recusado ou em atraso","#e6f4ff","#1677ff",
  ["o serviço já foi executado"],
  ["sem rollback: não se desfaz um conserto","OS retida em **AGUARDANDO_PAGAMENTO**","cliente paga de novo pelo mesmo link","reconciliação com o Mercado Pago","a cada 15 min fecha webhooks perdidos"]),
]
x=40; cw=600; y=315
for (t,f,st,gat,trat) in cols:
    S.box(x,y,cw,555,f,st,rx=14)
    S.text(x+cw/2,y+36,t,size=21,weight="bold",color=st)
    S.text(x+28,y+86,"Quando:",size=18,weight="bold",anchor="start",color="#434343")
    for k,l in enumerate(gat): S.text(x+28,y+122+k*34,l,size=20,anchor="start")
    S.text(x+28,y+222,"Como a saga trata:",size=18,weight="bold",anchor="start",color="#434343")
    for k,l in enumerate(trat):
        bold=l.count('**')
        segs=l.split('**')
        if bold:
            # render mixed: simple approach -> whole line bold if contains **
            S.text(x+28,y+266+k*50,l.replace('**',''),size=21,anchor="start",weight="bold")
        else:
            S.text(x+28,y+266+k*50,l,size=21,anchor="start")
    x+=cw+20

S.box(40,895,1840,150,"#fafafa","#8c8c8c",rx=12)
S.text(960,930,"Garantias em todos os casos",size=21,weight="bold",color="#262626")
S.text(960,985,["idempotência: comandos pelo número da OS · callbacks pelo id do envelope · movimentações de estoque com id fixo","lock otimista com retry · estado da saga consultável em GET /ordens-servico/numero/{n}/saga"],size=19,color="#434343")
S.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '12-saga-falhas.svg'))
