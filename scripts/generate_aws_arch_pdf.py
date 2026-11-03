#!/usr/bin/env python3
"""
Generate AWS_DEPLOYMENT_ARCHITECTURE.pdf from docs/AWS_DEPLOYMENT_ARCHITECTURE.md.

Companion to generate_arch_doc.py, which renders docs/ARCHITECTURE.md to .docx.
Same convention: the markdown is the source of truth, the binary is generated.

Uses reportlab (no LaTeX or headless browser required). The mermaid topology in
the markdown is not rendered by a browser -- it is replaced by a native vector
drawing (ArchDiagram) keyed off the `<!-- pdf-diagram: aws-topology -->` marker
that precedes it, so the PDF gets a crisp diagram with no external toolchain.

Usage:
    python3 scripts/generate_aws_arch_pdf.py
"""

import re
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    HRFlowable,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
INPUT_PATH = REPO_ROOT / "docs" / "AWS_DEPLOYMENT_ARCHITECTURE.md"
OUTPUT_PATH = REPO_ROOT / "AWS_DEPLOYMENT_ARCHITECTURE.pdf"

DIAGRAM_MARKER = "<!-- pdf-diagram: aws-topology -->"

PAGE_W, PAGE_H = A4
MARGIN_L = MARGIN_R = 22 * mm
MARGIN_T = 20 * mm
MARGIN_B = 18 * mm
CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R  # ~495pt

FONT = "DejaVu"
FONT_B = "DejaVu-Bold"
FONT_M = "DejaVuMono"
FONT_MB = "DejaVuMono-Bold"

NAVY = colors.HexColor("#1F3A5F")
INK = colors.HexColor("#202124")
MUTED = colors.HexColor("#5F6368")
RULE = colors.HexColor("#D6DAE0")
TABLE_HEAD_BG = colors.HexColor("#1F3A5F")
TABLE_ALT_BG = colors.HexColor("#F5F7FA")
CODE_BG = colors.HexColor("#F1F3F4")
LINK = colors.HexColor("#1967D2")

# Diagram palette -- (fill, stroke) per layer.
C_NET = (colors.HexColor("#E8F0FE"), colors.HexColor("#1967D2"))
C_COMPUTE = (colors.HexColor("#FFF4E5"), colors.HexColor("#D97706"))
C_DATA = (colors.HexColor("#E6F4EA"), colors.HexColor("#137333"))
C_SEC = (colors.HexColor("#FCE8E6"), colors.HexColor("#C5221F"))
C_EXT = (colors.HexColor("#F1F3F4"), colors.HexColor("#5F6368"))
C_BAND_FILL = colors.HexColor("#FBFBFC")
C_BAND_LINE = colors.HexColor("#BDC1C6")


def register_fonts():
    """DejaVu covers the arrows, em dashes and middots the document uses."""
    base = Path("/usr/share/fonts/truetype/dejavu")
    faces = {
        FONT: "DejaVuSans.ttf",
        FONT_B: "DejaVuSans-Bold.ttf",
        FONT_M: "DejaVuSansMono.ttf",
        FONT_MB: "DejaVuSansMono-Bold.ttf",
    }
    for name, filename in faces.items():
        path = base / filename
        if not path.exists():
            sys.exit(f"Missing font: {path}")
        pdfmetrics.registerFont(TTFont(name, str(path)))
    pdfmetrics.registerFontFamily(FONT, normal=FONT, bold=FONT_B, italic=FONT, boldItalic=FONT_B)


# ---------------------------------------------------------------------------
# Vector architecture diagram
# ---------------------------------------------------------------------------
class ArchDiagram(Flowable):
    """The AWS topology, drawn natively so the PDF needs no mermaid toolchain."""

    def __init__(self, width=CONTENT_W, height=465):
        Flowable.__init__(self)
        self.width = width
        self.height = height

    def wrap(self, availWidth, availHeight):
        return self.width, self.height

    # -- primitives (all take top-down y; _y converts to reportlab's origin) --
    def _y(self, y):
        return self.height - y

    def _box(self, x, y, w, h, title, subtitle=None, palette=C_NET, radius=4):
        c = self.canv
        fill, stroke = palette
        c.setFillColor(fill)
        c.setStrokeColor(stroke)
        c.setLineWidth(1.1)
        c.roundRect(x, self._y(y + h), w, h, radius, stroke=1, fill=1)

        lines = [] if subtitle is None else (subtitle if isinstance(subtitle, list) else [subtitle])
        block_h = 10 + 8.4 * len(lines)
        ty = y + (h - block_h) / 2 + 8
        c.setFillColor(INK)
        c.setFont(FONT_B, 8.4)
        c.drawCentredString(x + w / 2, self._y(ty), title)
        c.setFont(FONT, 6.7)
        c.setFillColor(MUTED)
        for i, line in enumerate(lines):
            c.drawCentredString(x + w / 2, self._y(ty + 9.6 + i * 8.4), line)

    def _band(self, x, y, w, h, label):
        c = self.canv
        c.setFillColor(C_BAND_FILL)
        c.setStrokeColor(C_BAND_LINE)
        c.setLineWidth(0.8)
        c.setDash(3, 2)
        c.roundRect(x, self._y(y + h), w, h, 3, stroke=1, fill=1)
        c.setDash()
        c.setFont(FONT_B, 6.8)
        c.setFillColor(MUTED)
        c.drawString(x + 8, self._y(y + 11), label)

    def _arrow(self, pts, label=None, dashed=False, color=None):
        """Polyline through pts [(x, y_topdown), ...] with a head at the last point."""
        c = self.canv
        color = color or MUTED
        c.setStrokeColor(color)
        c.setFillColor(color)
        c.setLineWidth(1.0)
        if dashed:
            c.setDash(2.5, 2.5)
        path = c.beginPath()
        path.moveTo(pts[0][0], self._y(pts[0][1]))
        for px, py in pts[1:]:
            path.lineTo(px, self._y(py))
        c.drawPath(path, stroke=1, fill=0)
        c.setDash()

        (x1, y1), (x2, y2) = pts[-2], pts[-1]
        dx, dy = x2 - x1, y2 - y1
        length = max((dx * dx + dy * dy) ** 0.5, 0.001)
        ux, uy = dx / length, dy / length
        size, half = 6.0, 2.6
        bx, by = x2 - ux * size, y2 - uy * size
        head = c.beginPath()
        head.moveTo(x2, self._y(y2))
        head.lineTo(bx - uy * half, self._y(by + ux * half))
        head.lineTo(bx + uy * half, self._y(by - ux * half))
        head.close()
        c.drawPath(head, stroke=0, fill=1)

        if label:
            c.setFont(FONT, 6.2)
            c.setFillColor(MUTED)
            mid = len(pts) // 2
            mx = (pts[mid - 1][0] + pts[mid][0]) / 2
            my = (pts[mid - 1][1] + pts[mid][1]) / 2
            c.drawCentredString(mx, self._y(my - 3), label)

    def _caption(self, x, y, text, size=6.2, bold=False, centred=True):
        c = self.canv
        c.setFont(FONT_B if bold else FONT, size)
        c.setFillColor(MUTED)
        if centred:
            c.drawCentredString(x, self._y(y), text)
        else:
            c.drawString(x, self._y(y), text)

    def draw(self):
        c, W = self.canv, self.width
        self._box(25, 0, 190, 30, "Browser", "HTTPS to application; OIDC sign-in", C_EXT)
        self._box(285, 0, 160, 30, "Amazon Cognito", "Managed identity; TOTP MFA", C_SEC)
        self._arrow([(215, 15), (285, 15)], label="OIDC")
        c.setStrokeColor(MUTED)
        c.setLineWidth(1.2)
        c.setDash(5, 3)
        c.roundRect(0, self._y(313), W, 266, 5, stroke=1, fill=0)
        c.setDash()
        self._caption(12, 59, "VPC 10.20.0.0/16  |  ap-southeast-2  |  two AZs", 7.3, True, False)
        self._band(12, 68, W - 24, 65, "PUBLIC SUBNETS")
        self._box(25, 85, 190, 35, "Application Load Balancer", "ACM TLS; idle timeout 660 seconds", C_NET)
        self._box(300, 85, 145, 35, "NAT Gateway", "Single outbound gateway", C_NET)
        self._arrow([(120, 30), (120, 85)])
        self._band(12, 143, W - 24, 91, "PRIVATE APPLICATION SUBNETS  |  ECS Fargate")
        self._box(25, 166, 115, 54, "frontend", ["React / nginx", "0.25 vCPU / 512 MiB"], C_COMPUTE)
        self._box(165, 166, 125, 54, "backend", ["OIDC; Socket.IO; audit", "0.5 vCPU / 2048 MiB"], C_COMPUTE)
        self._box(320, 166, 125, 54, "ai-service", ["LangGraph / FastAPI", "0.5 vCPU / 2048 MiB"], C_COMPUTE)
        self._arrow([(100, 120), (82, 166)], label="/")
        self._arrow([(170, 120), (227, 166)], label="/api; /socket.io")
        self._arrow([(290, 192), (320, 192)])
        self._caption(305, 181, "key", 6.2)
        self._arrow([(382, 166), (372, 120)], dashed=True)
        self._band(12, 244, W - 24, 59, "PRIVATE DATA SUBNETS")
        self._box(145, 261, 165, 34, "RDS PostgreSQL 16.13", "Private; single-AZ; 7-day backups", C_DATA)
        self._arrow([(227, 220), (227, 261)])
        self._box(0, 335, 220, 40, "DynamoDB and S3", ["Agent state / memory / checkpoints", "Audit archive with Object Lock"], C_DATA)
        self._box(250, 335, 205, 40, "AWS Bedrock (Sydney)", "GPT-OSS 120B inference", C_SEC)
        self._box(0, 390, 220, 40, "Supporting AWS services", ["Secrets Manager / ECR", "CloudWatch / ADOT collectors"], C_SEC)
        self._box(250, 390, 205, 40, "External destinations", ["api.openai.com: embeddings", "api.smith.langchain.com: traces ON"], C_EXT)
        self._arrow([(445, 102), (W - 5, 102), (W - 5, 322), (360, 322), (360, 335)], dashed=True)
        self._arrow([(W - 5, 322), (W - 5, 382), (360, 382), (360, 390)], dashed=True)
        self._caption(0, 448, "Solid: application requests. Dashed: outbound model, embedding and trace access via NAT.", 6.6, centred=False)
        self._caption(0, 460, "The AI service has no public ALB rule. Managed stores are shown outside the VPC boundary.", 6.6, centred=False)


# ---------------------------------------------------------------------------
# Markdown parsing
# ---------------------------------------------------------------------------
def parse_markdown(text):
    """Return a list of (kind, payload) blocks for the subset this document uses."""
    lines = text.split("\n")
    blocks = []
    i, n = 0, len(lines)
    pending_diagram = False

    while i < n:
        line = lines[i]
        stripped = line.strip()

        if stripped == DIAGRAM_MARKER:
            pending_diagram = True
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        # Fenced code -- a mermaid fence after the marker becomes the vector diagram.
        if stripped.startswith("```"):
            lang = stripped[3:].strip()
            i += 1
            body = []
            while i < n and not lines[i].strip().startswith("```"):
                body.append(lines[i])
                i += 1
            i += 1
            if pending_diagram and lang == "mermaid":
                blocks.append(("diagram", None))
                pending_diagram = False
            else:
                blocks.append(("code", "\n".join(body)))
            continue

        if re.match(r"^(-{3,}|\*{3,})$", stripped):
            blocks.append(("hr", None))
            i += 1
            continue

        m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m:
            blocks.append(("h%d" % len(m.group(1)), m.group(2).strip()))
            i += 1
            continue

        if stripped.startswith(">"):
            quote = []
            while i < n and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip(">").strip())
                i += 1
            blocks.append(("quote", [q for q in quote if q]))
            continue

        # Table: a header row followed by a separator row.
        if stripped.startswith("|") and i + 1 < n and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                raw = lines[i].strip()
                if not re.match(r"^\|[\s:|-]+\|$", raw):
                    rows.append([c.strip() for c in raw.strip("|").split("|")])
                i += 1
            blocks.append(("table", rows))
            continue

        if re.match(r"^[-*]\s+", stripped):
            items, i = _collect_list(lines, i, n, r"^[-*]\s+")
            blocks.append(("ul", items))
            continue

        if re.match(r"^\d+\.\s+", stripped):
            items, i = _collect_list(lines, i, n, r"^\d+\.\s+")
            blocks.append(("ol", items))
            continue

        # Paragraph -- consume until a blank line or the start of another block.
        para = []
        while i < n and lines[i].strip():
            s = lines[i].strip()
            if (s.startswith(("|", ">", "#", "```")) or re.match(r"^[-*]\s+", s)
                    or re.match(r"^\d+\.\s+", s) or re.match(r"^(-{3,})$", s)):
                break
            para.append(s)
            i += 1
        if para:
            blocks.append(("p", " ".join(para)))
        else:
            i += 1

    return blocks


def _collect_list(lines, i, n, marker):
    """Collect list items, folding hanging-indent continuation lines into the item."""
    items = []
    while i < n and lines[i].strip():
        s = lines[i].strip()
        if re.match(marker, s):
            items.append(re.sub(marker, "", s, count=1))
            i += 1
        elif items and not s.startswith(("|", "#", "```", ">")):
            items[-1] += " " + s
            i += 1
        else:
            break
    return items, i


def inline(text):
    """Markdown inline formatting -> reportlab intra-paragraph markup."""
    out = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    out = re.sub(r"`([^`]+)`",
                 lambda m: '<font face="%s" size="8" backColor="#F1F3F4">%s</font>' % (FONT_M, m.group(1)),
                 out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", out)
    out = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
                 lambda m: '<font color="#1967D2">%s</font>' % m.group(1)
                 if m.group(2).startswith("#")
                 else '<link href="%s"><font color="#1967D2">%s</font></link>' % (m.group(2), m.group(1)),
                 out)
    return out


# ---------------------------------------------------------------------------
# Styles
# ---------------------------------------------------------------------------
def build_styles():
    body = ParagraphStyle("body", fontName=FONT, fontSize=9.2, leading=13.4,
                          textColor=INK, spaceAfter=7, alignment=TA_LEFT)
    return {
        "body": body,
        "h1": ParagraphStyle("h1", parent=body, fontName=FONT_B, fontSize=17, leading=21,
                             textColor=NAVY, spaceBefore=4, spaceAfter=10),
        "h2": ParagraphStyle("h2", parent=body, fontName=FONT_B, fontSize=13, leading=17,
                             textColor=NAVY, spaceBefore=16, spaceAfter=7),
        "h3": ParagraphStyle("h3", parent=body, fontName=FONT_B, fontSize=10.5, leading=14,
                             textColor=NAVY, spaceBefore=11, spaceAfter=5),
        "h4": ParagraphStyle("h4", parent=body, fontName=FONT_B, fontSize=9.4, leading=13,
                             textColor=INK, spaceBefore=9, spaceAfter=4),
        "quote": ParagraphStyle("quote", parent=body, fontSize=8.6, leading=12.4,
                                textColor=MUTED, leftIndent=10, spaceAfter=3),
        "cell": ParagraphStyle("cell", parent=body, fontSize=8, leading=10.8, spaceAfter=0),
        "cellhead": ParagraphStyle("cellhead", parent=body, fontName=FONT_B, fontSize=8,
                                   leading=10.8, textColor=colors.white, spaceAfter=0),
        "code": ParagraphStyle("code", parent=body, fontName=FONT_M, fontSize=7.6, leading=10,
                               backColor=CODE_BG, borderPadding=6, spaceAfter=9),
        "title": ParagraphStyle("title", parent=body, fontName=FONT_B, fontSize=25, leading=31,
                                textColor=NAVY, alignment=TA_CENTER, spaceAfter=8),
        "subtitle": ParagraphStyle("subtitle", parent=body, fontSize=12.5, leading=17,
                                   textColor=MUTED, alignment=TA_CENTER, spaceAfter=22),
        "meta": ParagraphStyle("meta", parent=body, fontSize=9.4, leading=15,
                               textColor=MUTED, alignment=TA_CENTER, spaceAfter=3),
    }


def table_widths(rows):
    """Proportional column widths from content length, with a sane floor."""
    ncols = max(len(r) for r in rows)
    weights = []
    for col in range(ncols):
        longest = max((len(r[col]) if col < len(r) else 0) for r in rows)
        weights.append(max(longest, 6) ** 0.72)
    total = sum(weights)
    widths = [CONTENT_W * w / total for w in weights]

    floor = 42.0
    deficit = sum(floor - w for w in widths if w < floor)
    if deficit > 0:
        surplus = sum(w - floor for w in widths if w > floor)
        if surplus > 0:
            widths = [floor if w < floor else w - (w - floor) * deficit / surplus for w in widths]
    scale = CONTENT_W / sum(widths)
    return [w * scale for w in widths]


def make_table(rows, styles):
    ncols = max(len(r) for r in rows)
    data = []
    for ri, row in enumerate(rows):
        padded = row + [""] * (ncols - len(row))
        style = styles["cellhead"] if ri == 0 else styles["cell"]
        data.append([Paragraph(inline(c), style) for c in padded])

    tbl = Table(data, colWidths=table_widths(rows), repeatRows=1, hAlign="LEFT")
    cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), TABLE_HEAD_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, TABLE_HEAD_BG),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    for ri in range(2, len(data), 2):
        cmds.append(("BACKGROUND", (0, ri), (-1, ri), TABLE_ALT_BG))
    tbl.setStyle(TableStyle(cmds))
    return tbl


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def title_page(blocks, styles):
    title = next((p for k, p in blocks if k == "h1"), "Architecture")
    quote = next((p for k, p in blocks if k == "quote"), [])

    story = [Spacer(1, 150)]
    if "—" in title:
        main, _, sub = title.partition("—")
        story.append(Paragraph(main.strip(), styles["title"]))
        story.append(Paragraph(sub.strip(), styles["subtitle"]))
    else:
        story.append(Paragraph(title, styles["title"]))

    story.append(HRFlowable(width="45%", thickness=1.2, color=NAVY, hAlign="CENTER",
                            spaceBefore=6, spaceAfter=20))
    for line in quote:
        story.append(Paragraph(inline(line), styles["meta"]))

    story.append(Spacer(1, 190))
    story.append(Paragraph("Circini Migration Agent", styles["meta"]))
    story.append(Paragraph("Generated from docs/AWS_DEPLOYMENT_ARCHITECTURE.md", styles["meta"]))
    story.append(PageBreak())
    return story


def render(blocks, styles):
    story = []
    seen_h1 = False
    seen_quote = False

    for kind, payload in blocks:
        if kind == "h1":
            if not seen_h1:  # already used on the title page
                seen_h1 = True
                continue
            story.append(Paragraph(inline(payload), styles["h1"]))
        elif kind == "quote":
            if not seen_quote:
                seen_quote = True
                continue
            for line in payload:
                story.append(Paragraph(inline(line), styles["quote"]))
            story.append(Spacer(1, 5))
        elif kind == "h2":
            story.append(Paragraph(inline(payload), styles["h2"]))
            story.append(HRFlowable(width="100%", thickness=0.7, color=RULE,
                                    spaceBefore=0, spaceAfter=7))
        elif kind in ("h3", "h4"):
            story.append(Paragraph(inline(payload), styles[kind]))
        elif kind == "p":
            story.append(Paragraph(inline(payload), styles["body"]))
        elif kind in ("ul", "ol"):
            # Ordered lists need a wider gutter so two-digit numbers clear the text.
            indent = 16 if kind == "ul" else 22
            items = [ListItem(Paragraph(inline(t), styles["body"]), leftIndent=indent)
                     for t in payload]
            story.append(ListFlowable(
                items,
                bulletType="bullet" if kind == "ul" else "1",
                start="•" if kind == "ul" else "1",
                bulletFormat=None if kind == "ul" else "%s.",
                bulletFontName=FONT, bulletFontSize=8.2,
                leftIndent=indent, bulletDedent=indent, spaceAfter=6,
            ))
        elif kind == "table":
            story.append(Spacer(1, 2))
            story.append(make_table(payload, styles))
            story.append(Spacer(1, 10))
        elif kind == "code":
            text = payload.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            story.append(Paragraph(text.replace("\n", "<br/>"), styles["code"]))
        elif kind == "hr":
            story.append(Spacer(1, 3))
        elif kind == "diagram":
            # Pull the preceding section heading (Paragraph + rule) into the group
            # so it travels with the figure instead of being stranded above the
            # page break. No leading PageBreak -- KeepTogether moves the figure on
            # only when it genuinely does not fit, which avoids a blank page.
            lead = []
            if len(story) >= 2 and isinstance(story[-1], HRFlowable) and isinstance(story[-2], Paragraph):
                lead = [story.pop(-2), story.pop(-1)]
            story.append(KeepTogether(lead + [
                Paragraph("Figure 1 — Verified reference topology (November 3, 2026)", styles["h3"]),
                Spacer(1, 6),
                ArchDiagram(),
            ]))
            story.append(PageBreak())

    return story


def decorate(canvas, doc):
    """Footer rule, document name and page number -- suppressed on the title page."""
    if doc.page == 1:
        return
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN_L, MARGIN_B - 12, PAGE_W - MARGIN_R, MARGIN_B - 12)
    canvas.setFont(FONT, 7.4)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN_L, MARGIN_B - 23,
                      "Circini Migration Agent — AWS Deployment Guide")
    canvas.drawRightString(PAGE_W - MARGIN_R, MARGIN_B - 23, str(doc.page))
    canvas.restoreState()


def main():
    if not INPUT_PATH.exists():
        sys.exit(f"Missing input: {INPUT_PATH}")

    register_fonts()
    styles = build_styles()
    for name in ("h1", "h2", "h3", "h4"):
        styles[name].keepWithNext = True
    blocks = parse_markdown(INPUT_PATH.read_text(encoding="utf-8"))

    doc = BaseDocTemplate(
        str(OUTPUT_PATH), pagesize=A4,
        leftMargin=MARGIN_L, rightMargin=MARGIN_R,
        topMargin=MARGIN_T, bottomMargin=MARGIN_B,
        title="Circini Migration Agent — AWS Deployment Guide",
        author="Circini", subject="Verified deployment configuration and AWS deployment instructions",
    )
    frame = Frame(MARGIN_L, MARGIN_B, CONTENT_W, PAGE_H - MARGIN_T - MARGIN_B, id="body")
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=decorate)])

    story = title_page(blocks, styles) + render(blocks, styles)
    doc.build(story)

    print(f"Wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
