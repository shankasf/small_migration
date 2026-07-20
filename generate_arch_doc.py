#!/usr/bin/env python3
"""
Generate a professional .docx from ARCHITECTURE.md.

Uses python-docx to produce a well-formatted Word document with:
  - Title page
  - Table of contents
  - Proper heading hierarchy
  - Tables with borders and header shading
  - Code blocks in monospace with gray background
  - Bullet lists, bold text, blockquotes
  - Page breaks before major sections
  - Page numbers in the footer
"""

import glob
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from docx import Document
from docx.shared import Pt, Inches, Cm, RGBColor
from docx.shared import Emu
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_ORIENT
from docx.oxml.ns import qn, nsdecls
from docx.oxml import parse_xml

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
INPUT_PATH = Path(__file__).parent / "ARCHITECTURE.md"
OUTPUT_PATH = Path(__file__).parent / "ARCHITECTURE.docx"

FONT_BODY = "Calibri"
FONT_MONO = "Courier New"
SIZE_BODY = Pt(11)
SIZE_CODE = Pt(8)
SIZE_HEADING1 = Pt(20)
SIZE_HEADING2 = Pt(16)
SIZE_HEADING3 = Pt(13)
COLOR_HEADING = RGBColor(0x1F, 0x3A, 0x5F)  # dark navy
COLOR_CODE_BG = "D9D9D9"  # light gray
COLOR_TABLE_HEADER_BG = "2F5496"  # dark blue
COLOR_TABLE_HEADER_FG = RGBColor(0xFF, 0xFF, 0xFF)
COLOR_BLOCKQUOTE = RGBColor(0x55, 0x55, 0x55)

# ---------------------------------------------------------------------------
# Mermaid rendering (diagrams -> PNG embedded in the document)
# ---------------------------------------------------------------------------
_MERMAID_DIR = tempfile.mkdtemp(prefix="mermaid_")
_MERMAID_INDEX = [0]


def _find_chrome():
    """Locate a Chromium/Chrome executable for mermaid-cli (puppeteer)."""
    for name in ("chromium", "chromium-browser", "google-chrome",
                 "google-chrome-stable", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    for pat in (
        os.path.expanduser("~/.cache/puppeteer/chrome/*/chrome-linux*/chrome"),
        os.path.expanduser("~/.cache/puppeteer/chrome-headless-shell/*/*/chrome-headless-shell"),
    ):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[-1]
    return None


def _find_mmdc():
    local = Path(__file__).parent / "node_modules" / ".bin" / "mmdc"
    if local.exists():
        return str(local)
    return shutil.which("mmdc")


_MMDC = _find_mmdc()
_CHROME = _find_chrome()
_PUPPETEER_CFG = None
if _CHROME:
    _PUPPETEER_CFG = os.path.join(_MERMAID_DIR, "puppeteer.json")
    Path(_PUPPETEER_CFG).write_text(
        json.dumps({"executablePath": _CHROME,
                    "args": ["--no-sandbox", "--disable-gpu"]})
    )


def render_mermaid_png(code: str):
    """Render a mermaid diagram to a PNG. Returns the file path, or None on failure."""
    if not _MMDC or not _CHROME:
        return None
    _MERMAID_INDEX[0] += 1
    idx = _MERMAID_INDEX[0]
    mmd = os.path.join(_MERMAID_DIR, f"diagram_{idx}.mmd")
    png = os.path.join(_MERMAID_DIR, f"diagram_{idx}.png")
    Path(mmd).write_text(code, encoding="utf-8")
    cmd = [_MMDC, "-i", mmd, "-o", png, "-b", "white", "-s", "3"]
    if _PUPPETEER_CFG:
        cmd += ["-p", _PUPPETEER_CFG]
    env = dict(os.environ, PUPPETEER_CACHE_DIR=os.path.expanduser("~/.cache/puppeteer"))
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! mermaid render error (diagram {idx}): {exc}")
        return None
    if r.returncode != 0 or not os.path.exists(png):
        print(f"  ! mermaid render failed (diagram {idx}): {r.stderr.strip()[:200]}")
        return None
    print(f"  + rendered diagram {idx}")
    return png


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def set_cell_shading(cell, color_hex: str):
    """Apply background shading to a table cell."""
    shading = parse_xml(
        f'<w:shd {nsdecls("w")} w:fill="{color_hex}" w:val="clear"/>'
    )
    cell._tc.get_or_add_tcPr().append(shading)


def set_paragraph_shading(paragraph, color_hex: str):
    """Apply background shading to a paragraph."""
    shading = parse_xml(
        f'<w:shd {nsdecls("w")} w:fill="{color_hex}" w:val="clear"/>'
    )
    paragraph._p.get_or_add_pPr().append(shading)


def set_table_borders(table):
    """Set borders on all cells in a table."""
    tbl = table._tbl
    tblPr = tbl.tblPr if tbl.tblPr is not None else parse_xml(f'<w:tblPr {nsdecls("w")}/>')
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        '  <w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/>'
        '  <w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/>'
        '  <w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/>'
        '  <w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/>'
        '  <w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/>'
        '  <w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>'
        '</w:tblBorders>'
    )
    tblPr.append(borders)


def add_run_with_formatting(paragraph, text, bold=False, font_name=FONT_BODY, font_size=SIZE_BODY, color=None):
    """Add a run to a paragraph with specified formatting."""
    run = paragraph.add_run(text)
    run.font.name = font_name
    run.font.size = font_size
    run.bold = bold
    if color:
        run.font.color.rgb = color
    return run


def add_formatted_text(paragraph, text, font_name=FONT_BODY, font_size=SIZE_BODY):
    """Parse inline markdown (bold) and add runs to the paragraph."""
    # Split on **bold** markers
    parts = re.split(r'(\*\*.*?\*\*)', text)
    for part in parts:
        if part.startswith('**') and part.endswith('**'):
            inner = part[2:-2]
            add_run_with_formatting(paragraph, inner, bold=True, font_name=font_name, font_size=font_size)
        else:
            # Handle `inline code`
            code_parts = re.split(r'(`[^`]+`)', part)
            for cp in code_parts:
                if cp.startswith('`') and cp.endswith('`'):
                    inner = cp[1:-1]
                    run = add_run_with_formatting(
                        paragraph, inner, font_name=FONT_MONO, font_size=Pt(9)
                    )
                    run.font.color.rgb = RGBColor(0x80, 0x00, 0x00)
                else:
                    if cp:
                        add_run_with_formatting(paragraph, cp, font_name=font_name, font_size=font_size)


def add_page_number(section):
    """Add page number to the footer of a section."""
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    # Page number field
    run = p.add_run()
    run.font.name = FONT_BODY
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
    fldChar1 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="begin"/>')
    run._r.append(fldChar1)
    run2 = p.add_run()
    instrText = parse_xml(f'<w:instrText {nsdecls("w")} xml:space="preserve"> PAGE </w:instrText>')
    run2._r.append(instrText)
    run3 = p.add_run()
    fldChar2 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="end"/>')
    run3._r.append(fldChar2)


def add_header_text(section, text):
    """Add header text to the section."""
    header = section.header
    header.is_linked_to_previous = False
    p = header.paragraphs[0] if header.paragraphs else header.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = p.add_run(text)
    run.font.name = FONT_BODY
    run.font.size = Pt(8)
    run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
    run.italic = True


# ---------------------------------------------------------------------------
# Parse markdown into blocks
# ---------------------------------------------------------------------------

def parse_markdown(md_text: str) -> list:
    """
    Parse markdown text into a list of block dicts.
    Each block has a 'type' and relevant content fields.
    """
    lines = md_text.split('\n')
    blocks = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]

        # Horizontal rule
        if re.match(r'^---+\s*$', line):
            i += 1
            continue

        # Empty line
        if line.strip() == '':
            i += 1
            continue

        # Headings: # Title, ## Section, ### Subsection
        m = re.match(r'^(#{1,6})\s+(.*)', line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            blocks.append({'type': 'heading', 'level': level, 'text': title})
            i += 1
            continue

        # Code block (fenced ```)
        if line.strip().startswith('```'):
            lang = line.strip()[3:].strip()
            code_lines = []
            i += 1
            while i < n and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i])
                i += 1
            i += 1  # skip closing ```
            blocks.append({'type': 'code', 'lang': lang, 'text': '\n'.join(code_lines)})
            continue

        # Table: starts with | and has at least one |---|
        if line.strip().startswith('|') and i + 1 < n and re.match(r'^\|[\s\-:|]+\|', lines[i + 1]):
            table_lines = []
            while i < n and lines[i].strip().startswith('|'):
                table_lines.append(lines[i])
                i += 1
            # Parse table
            # First line: header
            # Second line: separator (skip)
            # Remaining: data rows
            header_cells = [c.strip() for c in table_lines[0].strip('|').split('|')]
            data_rows = []
            for tl in table_lines[2:]:
                cells = [c.strip() for c in tl.strip('|').split('|')]
                data_rows.append(cells)
            blocks.append({'type': 'table', 'headers': header_cells, 'rows': data_rows})
            continue

        # Blockquote
        if line.strip().startswith('>'):
            bq_lines = []
            while i < n and lines[i].strip().startswith('>'):
                bq_lines.append(lines[i].strip().lstrip('>').strip())
                i += 1
            blocks.append({'type': 'blockquote', 'text': '\n'.join(bq_lines)})
            continue

        # Bullet list (- item or - [ ] item)
        if re.match(r'^\s*[-*]\s', line):
            items = []
            while i < n and re.match(r'^\s*[-*]\s', lines[i]):
                item_line = re.sub(r'^\s*[-*]\s+', '', lines[i])
                is_checklist = False
                checked = False
                if item_line.startswith('[ ] '):
                    is_checklist = True
                    checked = False
                    item_line = item_line[4:]
                elif item_line.startswith('[x] ') or item_line.startswith('[X] '):
                    is_checklist = True
                    checked = True
                    item_line = item_line[4:]
                items.append({'text': item_line, 'checklist': is_checklist, 'checked': checked})
                i += 1
            blocks.append({'type': 'list', 'items': items})
            continue

        # Numbered list
        if re.match(r'^\s*\d+\.\s', line):
            items = []
            while i < n and re.match(r'^\s*\d+\.\s', lines[i]):
                item_line = re.sub(r'^\s*\d+\.\s+', '', lines[i])
                items.append({'text': item_line})
                i += 1
            blocks.append({'type': 'numbered_list', 'items': items})
            continue

        # Regular paragraph — collect consecutive non-empty, non-special lines
        para_lines = []
        while i < n:
            cl = lines[i]
            if cl.strip() == '':
                break
            if re.match(r'^#{1,6}\s', cl):
                break
            if cl.strip().startswith('```'):
                break
            if cl.strip().startswith('|') and i + 1 < n and re.match(r'^\|[\s\-:|]+\|', lines[i + 1]):
                break
            if cl.strip().startswith('>'):
                break
            if re.match(r'^\s*[-*]\s', cl):
                break
            if re.match(r'^\s*\d+\.\s', cl):
                break
            if re.match(r'^---+\s*$', cl):
                break
            para_lines.append(cl)
            i += 1
        if para_lines:
            blocks.append({'type': 'paragraph', 'text': ' '.join(para_lines)})

    return blocks


# ---------------------------------------------------------------------------
# Render blocks into the docx
# ---------------------------------------------------------------------------

def create_title_page(doc: Document):
    """Create a professional title page."""
    # Add spacing before title
    for _ in range(6):
        p = doc.add_paragraph()
        p.space_after = Pt(0)
        p.space_before = Pt(0)

    # Title
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run("Circini Migration Agent")
    run.font.name = FONT_BODY
    run.font.size = Pt(32)
    run.font.color.rgb = COLOR_HEADING
    run.bold = True

    # Subtitle
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run("Architecture Document")
    run.font.name = FONT_BODY
    run.font.size = Pt(24)
    run.font.color.rgb = RGBColor(0x44, 0x72, 0xC4)

    # Horizontal line (using a bottom border on a paragraph)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pPr = p._p.get_or_add_pPr()
    pBdr = parse_xml(
        f'<w:pBdr {nsdecls("w")}>'
        '  <w:bottom w:val="single" w:sz="12" w:space="1" w:color="4472C4"/>'
        '</w:pBdr>'
    )
    pPr.append(pBdr)

    # Spacing
    doc.add_paragraph()

    # Version info
    info_items = [
        ("Version", "2.0"),
        ("Date", "July 20, 2026"),
        ("Domain", "https://migration.callsphere.tech"),
        ("Repository", "https://github.com/shankasf/E-Commerce-Voice-Agent.git"),
    ]
    for label, value in info_items:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.space_after = Pt(4)
        run = p.add_run(f"{label}: ")
        run.font.name = FONT_BODY
        run.font.size = Pt(12)
        run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
        run.bold = True
        run = p.add_run(value)
        run.font.name = FONT_BODY
        run.font.size = Pt(12)
        run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)

    # Page break after title page
    doc.add_page_break()


def create_toc(doc: Document, blocks: list):
    """Create a static table of contents."""
    p = doc.add_paragraph()
    run = p.add_run("Table of Contents")
    run.font.name = FONT_BODY
    run.font.size = Pt(22)
    run.font.color.rgb = COLOR_HEADING
    run.bold = True
    p.space_after = Pt(12)

    toc_num = 0
    for block in blocks:
        if block['type'] == 'heading':
            level = block['level']
            text = block['text']
            # Only include ## (level 2) and ### (level 3) in TOC
            if level == 2:
                toc_num += 1
                p = doc.add_paragraph()
                p.space_after = Pt(2)
                p.space_before = Pt(2)
                run = p.add_run(text)
                run.font.name = FONT_BODY
                run.font.size = Pt(12)
                run.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
                run.bold = True
            elif level == 3:
                p = doc.add_paragraph()
                p.space_after = Pt(1)
                p.space_before = Pt(1)
                # Indent sub-sections
                p.paragraph_format.left_indent = Inches(0.4)
                run = p.add_run(text)
                run.font.name = FONT_BODY
                run.font.size = Pt(11)
                run.font.color.rgb = RGBColor(0x44, 0x72, 0xC4)

    doc.add_page_break()


def render_blocks(doc: Document, blocks: list):
    """Render parsed blocks into the document."""
    is_first_h2 = True

    for block in blocks:
        btype = block['type']

        if btype == 'heading':
            level = block['level']
            text = block['text']

            if level == 1:
                # Skip the main title — we have a title page
                continue
            elif level == 2:
                # Major section: page break before (except the first one after TOC)
                if not is_first_h2:
                    doc.add_page_break()
                is_first_h2 = False

                p = doc.add_heading(text, level=1)
                for run in p.runs:
                    run.font.name = FONT_BODY
                    run.font.size = SIZE_HEADING1
                    run.font.color.rgb = COLOR_HEADING
                p.space_after = Pt(12)

            elif level == 3:
                p = doc.add_heading(text, level=2)
                for run in p.runs:
                    run.font.name = FONT_BODY
                    run.font.size = SIZE_HEADING2
                    run.font.color.rgb = RGBColor(0x44, 0x72, 0xC4)
                p.space_after = Pt(8)
                p.space_before = Pt(16)

            elif level >= 4:
                p = doc.add_heading(text, level=3)
                for run in p.runs:
                    run.font.name = FONT_BODY
                    run.font.size = SIZE_HEADING3
                    run.font.color.rgb = RGBColor(0x44, 0x72, 0xC4)
                p.space_after = Pt(6)
                p.space_before = Pt(12)

        elif btype == 'paragraph':
            p = doc.add_paragraph()
            add_formatted_text(p, block['text'])
            p.space_after = Pt(6)
            p.paragraph_format.line_spacing = Pt(16)

        elif btype == 'blockquote':
            text = block['text']
            # Render each line as a blockquote paragraph
            for line in text.split('\n'):
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Inches(0.3)
                # Add a left border
                pPr = p._p.get_or_add_pPr()
                pBdr = parse_xml(
                    f'<w:pBdr {nsdecls("w")}>'
                    '  <w:left w:val="single" w:sz="12" w:space="4" w:color="4472C4"/>'
                    '</w:pBdr>'
                )
                pPr.append(pBdr)
                set_paragraph_shading(p, "F2F2F2")
                add_formatted_text(p, line, font_size=Pt(10))
                for run in p.runs:
                    run.font.color.rgb = COLOR_BLOCKQUOTE
                    run.italic = True
                p.space_after = Pt(2)

        elif btype == 'code':
            code_text = block['text']

            # Mermaid diagrams: render to an embedded image instead of source text.
            if block.get('lang') == 'mermaid':
                png = render_mermaid_png(code_text)
                if png:
                    # Fit the image to the usable page width (page - margins).
                    sec = doc.sections[0]
                    usable = sec.page_width - sec.left_margin - sec.right_margin
                    pic_p = doc.add_paragraph()
                    pic_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    pic_p.space_before = Pt(6)
                    pic_p.space_after = Pt(10)
                    run = pic_p.add_run()
                    try:
                        run.add_picture(png, width=Emu(int(usable)))
                    except Exception:  # noqa: BLE001
                        run.add_picture(png)
                    continue
                # else: fall through to monospace source rendering

            # Render the whole code block as a single paragraph with monospace font
            # and gray background
            p = doc.add_paragraph()
            p.space_before = Pt(6)
            p.space_after = Pt(6)
            set_paragraph_shading(p, COLOR_CODE_BG)

            # Add a thin border
            pPr = p._p.get_or_add_pPr()
            pBdr = parse_xml(
                f'<w:pBdr {nsdecls("w")}>'
                '  <w:top w:val="single" w:sz="2" w:space="2" w:color="BBBBBB"/>'
                '  <w:left w:val="single" w:sz="2" w:space="4" w:color="BBBBBB"/>'
                '  <w:bottom w:val="single" w:sz="2" w:space="2" w:color="BBBBBB"/>'
                '  <w:right w:val="single" w:sz="2" w:space="4" w:color="BBBBBB"/>'
                '</w:pBdr>'
            )
            pPr.append(pBdr)

            run = p.add_run(code_text)
            run.font.name = FONT_MONO
            run.font.size = SIZE_CODE
            run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)

        elif btype == 'table':
            headers = block['headers']
            rows = block['rows']
            ncols = len(headers)

            table = doc.add_table(rows=1 + len(rows), cols=ncols)
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            set_table_borders(table)

            # Autofit
            table.autofit = True

            # Header row
            for j, header_text in enumerate(headers):
                cell = table.rows[0].cells[j]
                set_cell_shading(cell, COLOR_TABLE_HEADER_BG)
                p = cell.paragraphs[0]
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT
                # Parse bold in header
                clean = re.sub(r'\*\*(.*?)\*\*', r'\1', header_text)
                run = p.add_run(clean)
                run.font.name = FONT_BODY
                run.font.size = Pt(10)
                run.font.color.rgb = COLOR_TABLE_HEADER_FG
                run.bold = True

            # Data rows
            for i, row_data in enumerate(rows):
                for j in range(min(len(row_data), ncols)):
                    cell = table.rows[i + 1].cells[j]
                    # Alternate row shading
                    if i % 2 == 1:
                        set_cell_shading(cell, "F2F6FC")
                    p = cell.paragraphs[0]
                    add_formatted_text(p, row_data[j], font_size=Pt(10))

            # Spacing after table
            p = doc.add_paragraph()
            p.space_before = Pt(4)
            p.space_after = Pt(4)

        elif btype == 'list':
            for item in block['items']:
                text = item['text']
                if item.get('checklist'):
                    prefix = "[x] " if item.get('checked') else "[ ] "
                    p = doc.add_paragraph(style='List Bullet')
                    run = p.add_run(prefix)
                    run.font.name = FONT_MONO
                    run.font.size = Pt(10)
                    add_formatted_text(p, text, font_size=Pt(10))
                else:
                    p = doc.add_paragraph(style='List Bullet')
                    add_formatted_text(p, text)
                p.space_after = Pt(2)

        elif btype == 'numbered_list':
            for item in block['items']:
                p = doc.add_paragraph(style='List Number')
                add_formatted_text(p, item['text'])
                p.space_after = Pt(2)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"Reading {INPUT_PATH} ...")
    md_text = INPUT_PATH.read_text(encoding='utf-8')

    print("Parsing markdown ...")
    blocks = parse_markdown(md_text)
    print(f"  Found {len(blocks)} blocks")

    print("Creating document ...")
    doc = Document()

    # -- Page setup ----------------------------------------------------------
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(0.8)
    section.bottom_margin = Inches(0.8)
    section.left_margin = Inches(1.0)
    section.right_margin = Inches(1.0)

    # -- Default font -------------------------------------------------------
    style = doc.styles['Normal']
    style.font.name = FONT_BODY
    style.font.size = SIZE_BODY
    style.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
    style.paragraph_format.space_after = Pt(6)

    # -- Header / Footer -----------------------------------------------------
    add_header_text(section, "Circini Migration Agent  |  Architecture Document")
    add_page_number(section)

    # -- Title page ----------------------------------------------------------
    create_title_page(doc)

    # -- Table of Contents ---------------------------------------------------
    create_toc(doc, blocks)

    # -- Body ----------------------------------------------------------------
    render_blocks(doc, blocks)

    # -- Footer on last page -------------------------------------------------
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.space_before = Pt(24)
    run = p.add_run("Document generated on July 20, 2026. For questions, contact the engineering team.")
    run.font.name = FONT_BODY
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
    run.italic = True

    # -- Save ----------------------------------------------------------------
    print(f"Saving {OUTPUT_PATH} ...")
    doc.save(str(OUTPUT_PATH))

    size = OUTPUT_PATH.stat().st_size
    print(f"Done! File size: {size:,} bytes ({size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
