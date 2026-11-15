import html
class Slide:
    def __init__(s,W=1920,H=1080,title=""):
        s.W,s.H=W,H; s.o=[]
        s.o.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Inter, Helvetica Neue, Arial, sans-serif">')
        s.o.append('<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="#262626"/></marker><marker id="ahr" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="#cf1322"/></marker></defs>')
        s.o.append(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
        if title: s.text(W/2,46,title,size=32,weight="bold")
    def box(s,x,y,w,h,fill,stroke,dash=False,rx=10,sw=2):
        d=' stroke-dasharray="8 6"' if dash else ''
        s.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
    def text(s,x,y,lines,size=18,weight="normal",anchor="middle",color="#1f1f1f",lh=None):
        lh=lh or int(size*1.32)
        if isinstance(lines,str): lines=[lines]
        y0=y-(len(lines)-1)*lh/2
        for i,l in enumerate(lines):
            w=weight; c=color
            if l.startswith('**') and l.endswith('**'): l=l[2:-2]; w='bold'
            s.o.append(f'<text x="{x}" y="{y0+i*lh}" font-size="{size}" font-weight="{w}" text-anchor="{anchor}" dominant-baseline="middle" fill="{c}">{html.escape(l)}</text>')
    def node(s,x,y,w,h,lines,fill,stroke,size=17,dash=False,anchor="middle",pad=16):
        s.box(x,y,w,h,fill,stroke,dash=dash)
        if anchor=="start": s.text(x+pad,y+h/2,lines,size=size,anchor="start")
        else: s.text(x+w/2,y+h/2,lines,size=size)
    def label(s,x,y,t,size=14,color="#434343",border="#bfbfbf"):
        tw=len(t)*size*0.56+14
        s.o.append(f'<rect x="{x-tw/2}" y="{y-13}" width="{tw}" height="26" rx="5" fill="#ffffff" stroke="{border}"/>')
        s.text(x,y,t,size=size,color=color)
    def arrow(s,pts,color="#262626",dash=False,width=2.4,red=False):
        d=' stroke-dasharray="7 6"' if dash else ''
        p=" ".join(f"{a},{b}" for a,b in pts)
        m='ahr' if red else 'ah'
        s.o.append(f'<polyline points="{p}" fill="none" stroke="{color}" stroke-width="{width}"{d} marker-end="url(#{m})"/>')
    def save(s,path):
        s.o.append('</svg>'); open(path,'w').write("\n".join(s.o))
