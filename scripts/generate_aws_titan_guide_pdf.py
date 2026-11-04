#!/usr/bin/env python3
"""Render the AWS Titan guide with the established HNZ typography and layout."""
from pathlib import Path
import re
from html import escape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Table, TableStyle, PageBreak, Spacer, ListFlowable, ListItem, Flowable
import generate_aws_arch_pdf as base

ROOT=Path(__file__).resolve().parent.parent
OUTPUT=ROOT/'Circini_AWS_Titan_Deployment_Guide.pdf'
W,H=A4
M=46
CW=W-2*M
INK=colors.HexColor('#242423')
GRAY=colors.HexColor('#f5f4f0')
RULE=colors.HexColor('#dcd9d2')
TITLE='Circini Migration Agent — AWS Deployment Guide · Titan edition'


def fonts():
    base.register_fonts()
    folder=Path('/usr/share/fonts/truetype/liberation')
    for name,filename in [('HNZSans','LiberationSans-Regular.ttf'),('HNZBold','LiberationSans-Bold.ttf'),('HNZSerif','LiberationSerif-Regular.ttf'),('HNZMono','LiberationMono-Regular.ttf')]:
        pdfmetrics.registerFont(TTFont(name,str(folder/filename)))
    pdfmetrics.registerFontFamily('HNZSans',normal='HNZSans',bold='HNZBold',italic='HNZSans',boldItalic='HNZBold')


def inline(text):
    text=escape(text, quote=False)
    text=re.sub(r'`([^`]+)`',lambda m:'<font face="HNZMono" size="9.6" backColor="#f2f1ed">'+m[1]+'</font>',text)
    text=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',text)
    return re.sub(r'\[([^\]]+)\]\(([^)]+)\)',lambda m:'<link href="'+m[2]+'" color="#245c80">'+m[1]+'</link>',text)


def styles():
    p=ParagraphStyle('p',fontName='HNZSans',fontSize=11.35,leading=16.7,textColor=INK,spaceAfter=10.5)
    return {'p':p,
        'h1':ParagraphStyle('h1',parent=p,fontName='HNZSerif',fontSize=26,leading=28.5,spaceAfter=20,keepWithNext=True),
        'h2':ParagraphStyle('h2',parent=p,fontName='HNZSerif',fontSize=18,leading=23,spaceBefore=10,spaceAfter=10,keepWithNext=True),
        'h3':ParagraphStyle('h3',parent=p,fontName='HNZSerif',fontSize=15,leading=19,spaceBefore=11,spaceAfter=8,keepWithNext=True),
        'h4':ParagraphStyle('h4',parent=p,fontName='HNZSerif',fontSize=13,leading=17,spaceBefore=8,spaceAfter=7,keepWithNext=True),
        'cell':ParagraphStyle('cell',parent=p,fontSize=10.25,leading=14.2,spaceAfter=0),
        'head':ParagraphStyle('head',parent=p,fontSize=10.25,leading=14.2,textColor=colors.HexColor('#575653'),spaceAfter=0),
        'bullet':ParagraphStyle('bullet',parent=p,fontSize=11,leading=15.4,spaceAfter=7)}


class Code(Flowable):
    """Keep each shell line intact and preserve indentation in copy/paste."""
    def __init__(self,text):
        Flowable.__init__(self)
        self.lines=text.splitlines()
        self.size=9.15
        longest=max((pdfmetrics.stringWidth(x,'HNZMono',self.size) for x in self.lines),default=0)
        if longest>CW-18:
            self.size*= (CW-18)/longest
        if self.size<7.8:
            raise ValueError('Shell line too long: reformat source with continuations: '+max(self.lines,key=len))
        self.leading=self.size*1.43
        self.width=CW
        self.height=16+self.leading*len(self.lines)
        self.spaceAfter=11
    def wrap(self,aw,ah): return self.width,self.height
    def draw(self):
        c=self.canv
        c.setFillColor(colors.HexColor('#f7f7f5'))
        c.roundRect(0,0,self.width,self.height,4,fill=1,stroke=0)
        c.setFillColor(INK)
        c.setFont('HNZMono',self.size)
        y=self.height-9-self.size
        for line in self.lines:
            c.drawString(9,y,line)
            y-=self.leading


class NumberedCanvas(canvas.Canvas):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.states=[]
    def showPage(self):
        self.states.append(dict(self.__dict__))
        self._startPage()
    def save(self):
        total=len(self.states)
        for state in self.states:
            self.__dict__.update(state)
            self.setFillColor(colors.HexColor('#767674'))
            self.setFont('HNZSans',6.5)
            self.drawRightString(W-M,18,f'Page {self._pageNumber} of {total}')
            super().showPage()
        super().save()


def header(c,doc):
    c.saveState()
    c.setFillColor(colors.HexColor('#767674'))
    c.setFont('HNZSans',6.6)
    c.drawString(M,H-19,TITLE)
    c.restoreState()


def table(rows,ss):
    n=len(rows[0])
    if n==2: widths=[CW*.285,CW*.715]
    elif n==3: widths=[CW*.28,CW*.26,CW*.46]
    else: widths=[CW/n]*n
    data=[[Paragraph(inline(cell),ss['head'] if i==0 else ss['cell']) for cell in row] for i,row in enumerate(rows)]
    t=Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),GRAY),('GRID',(0,0),(-1,-1),.45,RULE),('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),5.5),('BOTTOMPADDING',(0,0),(-1,-1),5.5),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8)]))
    t.spaceAfter=12
    return t



class TitanDiagram(base.ArchDiagram):
    """Target AWS model flow, without an external-destinations node."""
    def __init__(self):
        super().__init__(width=CW, height=447)

    def draw(self):
        w = self.width
        self._box(18, 0, 190, 32, "Browser", "HTTPS application access", base.C_EXT)
        self._box(292, 0, 190, 32, "Amazon Cognito", "OIDC sign-in; TOTP MFA", base.C_SEC)
        self._arrow([(208, 16), (292, 16)], label="Sign in")
        self._caption(10, 53, "AWS ap-southeast-2 (Sydney) | VPC spans two availability zones", 7.6, True, False)
        self._band(0, 65, w, 250, "VPC 10.20.0.0/16")
        self._box(18, 90, 190, 36, "Application Load Balancer", "ACM HTTPS; public subnets", base.C_NET)
        self._box(337, 90, 145, 36, "NAT Gateway", "Outbound AWS API access", base.C_NET)
        self._arrow([(110, 32), (110, 39), (5, 39), (5, 108), (18, 108)])
        self._band(10, 145, w-20, 86, "PRIVATE APPLICATION SUBNETS | ECS FARGATE")
        self._box(22, 167, 125, 50, "frontend", ["React / nginx", "Browser application"], base.C_COMPUTE)
        self._box(182, 167, 125, 50, "backend", ["Node / Express", "API and access control"], base.C_COMPUTE)
        self._box(342, 167, 140, 50, "ai-service", ["Python / LangGraph", "Inference and embeddings"], base.C_COMPUTE)
        self._arrow([(85,126),(85,167)],label="/")
        self._arrow([(208,110),(244,110),(244,167)],label="/api")
        self._arrow([(307,192),(342,192)])
        self._caption(324,183,"key",6.2)
        self._arrow([(410,167),(410,126)],dashed=True)
        self._band(10, 244, w-20, 61, "PRIVATE DATA SUBNETS")
        self._box(152, 263, 185, 33, "RDS PostgreSQL + pgvector", "Application data; Titan vectors", base.C_DATA)
        self._arrow([(244,217),(244,263)])
        self._box(0, 335, 235, 43, "DynamoDB and S3", ["Agent state / memory / checkpoints", "Audit archive"], base.C_DATA)
        self._box(259, 335, 244, 70, "Amazon Bedrock (Sydney)", ["GPT-OSS 120B: chat inference", "Titan Text Embeddings V2", "1,024 dimensions; normalized"], base.C_SEC)
        self._arrow([(482,108),(w-2,108),(w-2,324),(382,324),(382,335)],dashed=True)
        self._box(0, 390, 235, 40, "Supporting AWS services", ["Secrets Manager / ECR", "CloudWatch / ADOT collectors"], base.C_SEC)
        self._caption(259, 425, "New environment: agent trace export disabled.", 6.5, centred=False)
        self._caption(0, 443, "Solid: application access. Dashed: model and embedding requests through NAT.", 6.8, centred=False)


def main():
    fonts(); ss=styles(); story=[]
    source=(ROOT/'docs/Circini_AWS_Titan_Deployment_Guide.md').read_text()
    sections=source.split('<!-- pagebreak -->')
    for pi,section in enumerate(sections):
        if pi: story.append(PageBreak())
        for kind,payload in base.parse_markdown(section):
            if kind in ss: story.append(Paragraph(inline(payload),ss[kind]))
            elif kind=='table': story.append(table(payload,ss))
            elif kind=='code': story.append(Code(payload))
            elif kind=='diagram':
                story.append(Spacer(1,10));story.append(TitanDiagram());story.append(Spacer(1,12))
            elif kind in ('ul','ol'):
                items=[ListItem(Paragraph(inline(t),ss['bullet'])) for t in payload]
                story.append(ListFlowable(items,bulletType='bullet' if kind=='ul' else '1',bulletFontName='HNZSans',bulletFontSize=7,leftIndent=14,bulletDedent=7,spaceAfter=7))
            elif kind=='quote':
                for t in payload: story.append(Paragraph(inline(t),ss['p']))
    doc=BaseDocTemplate(str(OUTPUT),pagesize=A4,title=TITLE,author='Circini',subject='AWS Titan deployment and operations; November 4, 2026',leftMargin=M,rightMargin=M,topMargin=51,bottomMargin=40)
    frame=Frame(M,40,CW,H-91,leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)
    doc.addPageTemplates(PageTemplate(id='hnz',frames=[frame],onPage=header))
    doc.build(story,canvasmaker=NumberedCanvas)
    print(OUTPUT)
    print(f'{OUTPUT.stat().st_size:,} bytes')

if __name__=='__main__': main()
