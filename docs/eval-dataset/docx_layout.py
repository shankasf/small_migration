"""Word layout for the offline regression eval dataset.

build_dataset.py owns the cases; this module only presents them. Everything is
drawn with python-docx plus a little raw OOXML for what the library does not
expose (borders, header rows, fields). The document must read the same in Word
and LibreOffice, so nothing here depends on Word updating fields: the table of
contents is pre-filled and Word only refreshes its page numbers on open.
"""
from __future__ import annotations

import datetime as dt
import json
from collections import Counter, defaultdict
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor, Twips

TITLE = "Offline Regression Evaluation Dataset"
PRODUCT = "Circini Migration Agent"
VERSION = "1.1"

# Palette: one navy for structure, one blue accent, greys for secondary text.
NAVY = "1F3864"
ACCENT = "2E75B6"
MUTED = "595959"
RULE = "C9D3E0"
PANEL = "F2F5F9"
ZEBRA = "F8FAFC"
SEVERITY_COLOUR = {"blocker": "B42318", "major": "B54708", "minor": "475467"}
SEVERITY_FILL = {"blocker": "FEF3F2", "major": "FFFAEB", "minor": "F2F4F7"}

BODY_FONT = "Calibri"
MONO_FONT = "Consolas"
CONTENT_WIDTH = Cm(17.0)  # A4 less 2 x 2.0 cm margins

# Reference-output keys in plain English, in the order a reviewer reads them.
CRITERIA = {
    "route": "Route to",
    "new_analysis": "Starts a new analysis",
    "flagged": "Guard flags the message",
    "expect": "Expected outcome",
    "continues": "Conversation continues",
    "asks_clarification": "Asks a clarifying question",
    "questions": "Clarifying questions asked",
    "files": "Files delivered",
    "expect_no_files": "No file attached",
    "max_files": "At most this many files",
    "required": "Required in the answer",
    "must_contain": "Reply must mention",
    "must_contain_any": "Reply mentions at least one of",
    "must_not_contain": "Reply must never contain",
    "sql_must_match": "SQL must match (regex)",
    "tools": "Tools that must be called",
    "any_tools": "At least one of these tools",
    "forbidden_tools": "Tools that must not be called",
    "not_blocked": "No turn is blocked",
    "checks": "Checks",
    "turns": "Per-turn expectations",
    "reference_answer": "Reference answer (judge)",
}

SHORT_CATEGORY = {"routing": "Routing", "injection guard": "Guard", "history/file delivery": "History / files",
                  "impact analysis": "Impact", "SQL/dbt model generation": "SQL / dbt", "mapping interpretation": "Mapping",
                  "GitHub/GitLab integration": "GitHub", "memory": "Memory", "clarification-asking": "Clarify",
                  "feedback": "Feedback"}
SHORT_AGENT = {"router": "Router", "guard": "Injection Guard", "grant_judge": "Grant Judge",
               "generation": "Migration build", "impact": "Impact pipeline", "history": "History Agent",
               "repository": "Repository Agent", "memory": "Memory", "consult": "Consultant"}
ROLE_LABEL = {"user": "User", "assistant": "Assistant", "system": "System"}


# --- low-level OOXML helpers ---------------------------------------------------------------------------------

def rgb(hex_colour: str) -> RGBColor:
    return RGBColor.from_string(hex_colour)


def _el(tag: str, **attrs: str):
    element = OxmlElement(tag)
    for key, value in attrs.items():
        element.set(qn(f"w:{key}"), value)
    return element


def shade(cell, fill: str) -> None:
    cell._tc.get_or_add_tcPr().append(_el("w:shd", val="clear", color="auto", fill=fill))


def cell_borders(cell, **sides: str) -> None:
    """sides: top/bottom/left/right = 'hex colour' or 'nil'."""
    borders = _el("w:tcBorders")
    for side, colour in sides.items():
        if colour == "nil":
            borders.append(_el(f"w:{side}", val="nil"))
        else:
            borders.append(_el(f"w:{side}", val="single", sz="6", space="0", color=colour))
    cell._tc.get_or_add_tcPr().append(borders)


def table_borders(table, colour: str = RULE, vertical: bool = False, outer: bool = True) -> None:
    borders = _el("w:tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        visible = (side in ("insideH",) or (outer and side in ("top", "bottom"))
                   or (vertical and side in ("left", "right", "insideV")))
        borders.append(_el(f"w:{side}", val="single" if visible else "nil", sz="4", space="0", color=colour))
    table._tbl.tblPr.append(borders)


def cell_margins(table, top=60, bottom=60, left=100, right=100) -> None:
    margins = _el("w:tblCellMar")
    for side, width in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        margins.append(_el(f"w:{side}", w=str(width), type="dxa"))
    table._tbl.tblPr.append(margins)


def header_row(row) -> None:
    """Repeat on every page and never split."""
    tr_pr = row._tr.get_or_add_trPr()
    tr_pr.append(_el("w:tblHeader"))
    tr_pr.append(_el("w:cantSplit"))


def no_split(row) -> None:
    row._tr.get_or_add_trPr().append(_el("w:cantSplit"))


def fixed_layout(table, widths) -> None:
    table.autofit = False
    table._tbl.tblPr.append(_el("w:tblLayout", type="fixed"))
    for index, width in enumerate(widths):
        table.columns[index].width = width
        for cell in table.columns[index].cells:
            cell.width = width


def paragraph_border(paragraph, side: str, colour: str, size: int = 8, space: int = 4) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    borders = p_pr.find(qn("w:pBdr"))
    if borders is None:
        borders = _el("w:pBdr")
        p_pr.append(borders)
    borders.append(_el(f"w:{side}", val="single", sz=str(size), space=str(space), color=colour))


def paragraph_shading(paragraph, fill: str) -> None:
    paragraph._p.get_or_add_pPr().append(_el("w:shd", val="clear", color="auto", fill=fill))


def add_field(paragraph, instruction: str, placeholder: str = "") -> None:
    """A complex field (PAGE, NUMPAGES) with a visible placeholder result."""
    def run_with(child):
        run = paragraph.add_run()
        run._r.append(child)
        return run
    run_with(_el("w:fldChar", fldCharType="begin"))
    instr = _el("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f" {instruction} "
    run_with(instr)
    run_with(_el("w:fldChar", fldCharType="separate"))
    paragraph.add_run(placeholder)
    run_with(_el("w:fldChar", fldCharType="end"))


def style_runs(paragraph, size=None, colour=None, bold=None, italic=None, font=None) -> None:
    for run in paragraph.runs:
        if size:
            run.font.size = Pt(size)
        if colour:
            run.font.color.rgb = rgb(colour)
        if bold is not None:
            run.bold = bold
        if italic is not None:
            run.italic = italic
        if font:
            run.font.name = font
            run._r.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), font)


# --- document builder ----------------------------------------------------------------------------------------

class Report:
    def __init__(self) -> None:
        self.doc = Document()
        self.toc: list[tuple[int, str]] = []
        self._setup_page()
        self._setup_styles()

    # page and styles
    def _setup_page(self) -> None:
        section = self.doc.sections[0]
        section.page_height, section.page_width = Cm(29.7), Cm(21.0)
        section.left_margin = section.right_margin = Cm(2.0)
        section.top_margin, section.bottom_margin = Cm(2.3), Cm(2.0)
        section.header_distance = section.footer_distance = Cm(1.0)
        section.different_first_page_header_footer = True

    def _setup_styles(self) -> None:
        styles = self.doc.styles
        normal = styles["Normal"]
        normal.font.name = BODY_FONT
        normal.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
        normal.font.size = Pt(10)
        normal.font.color.rgb = rgb("1D2939")
        normal.paragraph_format.space_after = Pt(6)
        normal.paragraph_format.line_spacing = 1.15

        for name, size, colour, before, after in (("Heading 1", 18, NAVY, 0, 10), ("Heading 2", 13, NAVY, 16, 6),
                                                  ("Heading 3", 11, ACCENT, 14, 4)):
            style = styles[name]
            style.font.name = BODY_FONT
            rfonts = style.element.get_or_add_rPr().get_or_add_rFonts()
            for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
                rfonts.set(qn(attr), BODY_FONT)
            for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
                if rfonts.get(qn(attr)) is not None:
                    del rfonts.attrib[qn(attr)]
            style.font.size = Pt(size)
            style.font.bold = True
            style.font.italic = False
            style.font.color.rgb = rgb(colour)
            style.paragraph_format.space_before = Pt(before)
            style.paragraph_format.space_after = Pt(after)
            style.paragraph_format.keep_with_next = True

        def paragraph_style(name, size, colour=None, font=BODY_FONT, bold=False, italic=False, after=4, before=0):
            style = styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
            style.base_style = normal
            style.font.name = font
            style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), font)
            style.font.size = Pt(size)
            style.font.bold, style.font.italic = bold, italic
            if colour:
                style.font.color.rgb = rgb(colour)
            style.paragraph_format.space_after = Pt(after)
            style.paragraph_format.space_before = Pt(before)
            return style

        code = paragraph_style("Code Block", 8, "1D2939", font=MONO_FONT, after=0)
        code.paragraph_format.line_spacing = 1.0
        code.paragraph_format.left_indent = Cm(0.3)
        paragraph_style("Note", 8.5, MUTED, italic=True, after=6)
        paragraph_style("Cell", 9, after=0).paragraph_format.line_spacing = 1.05
        paragraph_style("Cell Label", 8, MUTED, bold=True, after=0)
        paragraph_style("Cell Mono", 8, "1D2939", font=MONO_FONT, after=0).paragraph_format.line_spacing = 1.0
        paragraph_style("Contents 1", 10.5, NAVY, bold=True, after=2, before=6)
        paragraph_style("Contents 2", 9.5, "344054", after=1).paragraph_format.left_indent = Cm(0.6)

    @staticmethod
    def _right_tab(paragraph) -> None:
        """One right tab at the text edge; the built-in Header/Footer tabs would win otherwise."""
        stops = paragraph.paragraph_format.tab_stops
        for inherited in (Twips(4680), Twips(9360)):
            stops.add_tab_stop(inherited, WD_TAB_ALIGNMENT.CLEAR)
        stops.add_tab_stop(CONTENT_WIDTH, WD_TAB_ALIGNMENT.RIGHT)

    # running header and footer
    def header_footer(self, generated: str) -> None:
        section = self.doc.sections[0]
        header = section.header.paragraphs[0]
        header.text = ""
        self._right_tab(header)
        header.add_run(f"{PRODUCT}  |  {TITLE}")
        header.add_run("\tInternal")
        style_runs(header, size=8, colour=MUTED)
        paragraph_border(header, "bottom", RULE, size=4, space=4)

        footer = section.footer.paragraphs[0]
        footer.text = ""
        self._right_tab(footer)
        footer.add_run(f"Version {VERSION}  |  Generated {generated}")
        footer.add_run("\tPage ")
        add_field(footer, "PAGE", "1")
        footer.add_run(" of ")
        add_field(footer, "NUMPAGES", "1")
        style_runs(footer, size=8, colour=MUTED)
        paragraph_border(footer, "top", RULE, size=4, space=4)

    # text blocks
    def heading(self, text: str, level: int, toc: bool = True, page_break: bool = False):
        paragraph = self.doc.add_heading(text, level=level)
        paragraph.paragraph_format.page_break_before = page_break
        if level == 1:
            paragraph_border(paragraph, "bottom", NAVY, size=8, space=4)
        if toc and level <= 2:
            self.toc.append((level, text))
        return paragraph

    def text(self, value: str, style: str | None = None, bold_lead: str | None = None):
        paragraph = self.doc.add_paragraph(style=style)
        if bold_lead:
            paragraph.add_run(bold_lead).bold = True
        paragraph.add_run(value)
        return paragraph

    def bullets(self, items, lead: bool = False) -> None:
        for item in items:
            paragraph = self.doc.add_paragraph(style="List Bullet")
            paragraph.paragraph_format.space_after = Pt(3)
            if lead and isinstance(item, tuple):
                paragraph.add_run(item[0]).bold = True
                paragraph.add_run(item[1])
            else:
                paragraph.add_run(item)

    def code(self, lines: list[str], caption: str | None = None) -> None:
        if caption:
            self.text(caption, style="Cell Label").paragraph_format.space_before = Pt(4)
        for index, line in enumerate(lines):
            paragraph = self.doc.add_paragraph(line, style="Code Block")
            paragraph_shading(paragraph, PANEL)
            paragraph_border(paragraph, "left", ACCENT, size=12, space=6)
            paragraph.paragraph_format.keep_with_next = index < len(lines) - 1
        self.doc.add_paragraph().paragraph_format.space_after = Pt(2)

    def callout(self, title: str, body: str, colour: str = ACCENT, fill: str = PANEL) -> None:
        table = self.doc.add_table(rows=1, cols=1)
        fixed_layout(table, [CONTENT_WIDTH])
        cell = table.cell(0, 0)
        shade(cell, fill)
        cell_borders(cell, left=colour, top="nil", bottom="nil", right="nil")
        cell_margins(table, top=100, bottom=100, left=180, right=180)
        first = cell.paragraphs[0]
        first.style = "Cell"
        first.add_run(title).bold = True
        style_runs(first, colour=colour)
        body_paragraph = cell.add_paragraph(body, style="Cell")
        body_paragraph.paragraph_format.space_before = Pt(2)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(0)

    def table(self, rows: list[list], widths, header: bool = True, font: float = 9, mono_cols=(),
              align_right=(), zebra: bool = True, bold_first_col: bool = False, total_row: bool = False):
        table = self.doc.add_table(rows=len(rows), cols=len(rows[0]))
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        fixed_layout(table, widths)
        table_borders(table)
        cell_margins(table)
        for r, row in enumerate(rows):
            is_header = header and r == 0
            is_total = total_row and r == len(rows) - 1
            if is_header:
                header_row(table.rows[r])
            else:
                no_split(table.rows[r])
            for c, value in enumerate(row):
                cell = table.cell(r, c)
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                paragraph = cell.paragraphs[0]
                paragraph.style = "Cell Mono" if (c in mono_cols and not is_header) else "Cell"
                paragraph.add_run("" if value is None else str(value))
                if c in align_right:
                    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                style_runs(paragraph, size=font if c not in mono_cols or is_header else font - 0.5)
                if is_header:
                    shade(cell, NAVY)
                    style_runs(paragraph, colour="FFFFFF", bold=True)
                elif is_total:
                    shade(cell, PANEL)
                    style_runs(paragraph, bold=True)
                elif zebra and r % 2 == 0:
                    shade(cell, ZEBRA)
                if bold_first_col and c == 0 and not is_header:
                    style_runs(paragraph, bold=True)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(2)
        return table

    def page_break(self) -> None:
        self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # contents: pre-filled so every viewer shows it; Word refreshes page numbers
    def contents_placeholder(self):
        self.heading("Contents", 1, toc=False)
        return self.doc.add_paragraph()

    def fill_contents(self, anchor) -> None:
        paragraphs = []
        for level, text in self.toc:
            paragraph = anchor.insert_paragraph_before(style=f"Contents {level}")
            paragraph.paragraph_format.tab_stops.add_tab_stop(CONTENT_WIDTH, WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
            paragraph.add_run(text)
            paragraphs.append(paragraph)
        if not paragraphs:
            return
        # Wrap the entries in a TOC field so Word can rebuild them with page numbers.
        first, last = paragraphs[0], paragraphs[-1]
        begin = OxmlElement("w:r")
        begin.append(_el("w:fldChar", fldCharType="begin"))
        instr_run = OxmlElement("w:r")
        instr = _el("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = ' TOC \\o "1-2" \\h \\z \\u '
        instr_run.append(instr)
        separate = OxmlElement("w:r")
        separate.append(_el("w:fldChar", fldCharType="separate"))
        p_pr = first._p.pPr
        index = list(first._p).index(p_pr) + 1 if p_pr is not None else 0
        for offset, element in enumerate((begin, instr_run, separate)):
            first._p.insert(index + offset, element)
        end = OxmlElement("w:r")
        end.append(_el("w:fldChar", fldCharType="end"))
        last._p.append(end)
        anchor._p.getparent().remove(anchor._p)

    def update_fields_on_open(self) -> None:
        settings = self.doc.settings.element
        settings.append(_el("w:updateFields", val="true"))

    def save(self, path: Path) -> None:
        self.doc.save(path)


# --- content rendering ---------------------------------------------------------------------------------------

def describe_value(value) -> list[str]:
    """A reference value as one or more readable lines."""
    if isinstance(value, bool):
        return ["Yes" if value else "No"]
    if isinstance(value, (int, float)):
        return [str(value)]
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        if all(isinstance(item, (str, int, float, bool)) for item in value):
            return [f"•  {item}" for item in value] or ["(none)"]
        return [f"Turn {index}: {json.dumps(item, ensure_ascii=False)}" for index, item in enumerate(value, 1)]
    if isinstance(value, dict):
        return [f"{key}: {json.dumps(item, ensure_ascii=False) if not isinstance(item, str) else item}"
                for key, item in value.items()] or ["(none)"]
    return [json.dumps(value, ensure_ascii=False)]


def plain(text: str) -> str:
    """Chat text without Markdown emphasis and heading markers, which read as noise in print."""
    text = text.replace("**", "").replace("__", "")
    return "\n".join(line.lstrip("#").lstrip() if line.lstrip().startswith("#") else line for line in text.split("\n"))


def describe_source(source) -> str:
    if not isinstance(source, dict):
        return str(source)
    parts = []
    kind = source.get("kind")
    if kind == "transcript":
        parts.append(f"Development session {source.get('session', '')}".strip())
    elif kind:
        parts.append(str(kind).capitalize())
    for key in ("date", "incident", "commit"):
        if source.get(key):
            parts.append(f"{'commit ' if key == 'commit' else ''}{source[key]}")
    text = ", ".join(parts)
    if source.get("topic"):
        text += f". {source['topic'][0].upper()}{source['topic'][1:]}"
    if source.get("note"):
        text += f". {source['note']}"
    return text


def case_card(report: Report, number: str, case: dict, agent_name: str) -> None:
    doc = report.doc
    heading = report.heading(f"{number}  {case['case_id']}", 3, toc=False)
    heading.paragraph_format.keep_with_next = True

    # Summary strip: suite, category, agent, severity.
    strip = doc.add_table(rows=2, cols=4)
    widths = [Cm(3.4), Cm(4.4), Cm(6.0), Cm(3.2)]
    fixed_layout(strip, widths)
    table_borders(strip, outer=False)
    cell_margins(strip, top=40, bottom=40, left=100, right=100)
    labels = ["SUITE", "CATEGORY", "AGENT", "SEVERITY"]
    values = [case["suite"], case["category"], agent_name, case["severity"].upper()]
    for c in range(4):
        top, bottom = strip.cell(0, c), strip.cell(1, c)
        for cell in (top, bottom):
            shade(cell, PANEL if case["severity"] != "blocker" or c != 3 else SEVERITY_FILL["blocker"])
        if c == 3:
            for cell in (top, bottom):
                shade(cell, SEVERITY_FILL[case["severity"]])
        top.paragraphs[0].style = "Cell Label"
        top.paragraphs[0].add_run(labels[c])
        bottom.paragraphs[0].style = "Cell"
        bottom.paragraphs[0].add_run(values[c])
        style_runs(bottom.paragraphs[0], bold=True,
                   colour=SEVERITY_COLOUR[case["severity"]] if c == 3 else "1D2939")
        top.paragraphs[0].paragraph_format.keep_with_next = True
        bottom.paragraphs[0].paragraph_format.keep_with_next = True
    for row in strip.rows:
        no_split(row)

    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing = Pt(4)
    spacer.paragraph_format.keep_with_next = True

    # Specification: label column + content column.
    rows: list[tuple[str, list[tuple[str, str]]]] = []
    rows.append(("Guards against", [("text", case["regression_of"])]))
    turns = case["turns"]
    if turns:
        rows.append(("Conversation so far", [("turn", f"{ROLE_LABEL.get(t['role'], t['role'])}  {plain(t['content'])}")
                                             for t in turns]))
    rows.append(("User message under test", [("quote", case["input"])]))
    if case["attached_files"]:
        rows.append(("Attached files", [("text", f"{f['name']}  ({f.get('kind', 'file')}"
                                                 + (f", fixture {f['fixture']}" if f.get("fixture") else "") + ")")
                                        for f in case["attached_files"]]))
    rows.append(("Expected behaviour", [("text", case["expected_behaviour"])]))
    criteria = []
    ordered = sorted(case["reference_outputs"].items(),
                     key=lambda kv: list(CRITERIA).index(kv[0]) if kv[0] in CRITERIA else len(CRITERIA))
    for key, value in ordered:
        criteria.append(("criterion", CRITERIA.get(key, key.replace("_", " ").capitalize())))
        # Prose (a judge's reference answer) reads better in the body font; patterns and ids stay monospaced.
        kind = "prose" if key == "reference_answer" else "mono"
        criteria.extend((kind, line) for line in describe_value(value))
    rows.append(("Pass criteria", criteria or [("text", "(none)")]))
    rows.append(("Evaluators", [("text", ", ".join(case["evaluators"]))]))
    rows.append(("Source", [("text", describe_source(case["source"]))]))
    if not case["harness"].get("example"):
        rows.append(("Offline runnable", [("text", "No. Listed for review only.")]))

    spec = doc.add_table(rows=len(rows), cols=2)
    fixed_layout(spec, [Cm(3.6), Cm(13.4)])
    table_borders(spec)
    cell_margins(spec, top=50, bottom=50, left=100, right=100)
    for r, (label, blocks) in enumerate(rows):
        label_cell, content_cell = spec.cell(r, 0), spec.cell(r, 1)
        shade(label_cell, PANEL)
        label_paragraph = label_cell.paragraphs[0]
        label_paragraph.style = "Cell Label"
        label_paragraph.add_run(label)
        first = True
        for kind, value in blocks:
            paragraph = content_cell.paragraphs[0] if first else content_cell.add_paragraph()
            first = False
            if kind == "mono":
                paragraph.style = "Cell Mono"
                paragraph.paragraph_format.left_indent = Cm(0.3)
                paragraph.add_run(value)
            elif kind == "prose":
                paragraph.style = "Cell"
                paragraph.paragraph_format.left_indent = Cm(0.3)
                paragraph.add_run(value)
            elif kind == "criterion":
                paragraph.style = "Cell"
                paragraph.paragraph_format.space_before = Pt(2)
                paragraph.add_run(value).bold = True
            elif kind == "turn":
                paragraph.style = "Cell"
                role, _, content = value.partition("  ")
                paragraph.add_run(f"{role}: ").bold = True
                paragraph.add_run(content)
                paragraph.paragraph_format.space_after = Pt(2)
            elif kind == "quote":
                paragraph.style = "Cell"
                paragraph.add_run(f"“{value}”").italic = True
            else:
                paragraph.style = "Cell"
                paragraph.add_run(value)
        # Keep short rows whole; long ones (transcripts, criteria) may flow across pages.
        if sum(len(v) for _, v in blocks) < 600:
            no_split(spec.rows[r])
    # Keep the card on one page where it fits: chain every paragraph to the next.
    last = len(spec.rows) - 1
    for r, row in enumerate(spec.rows):
        for cell in row.cells:
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.keep_with_next = r < last
    doc.add_paragraph().paragraph_format.space_after = Pt(4)


# --- the document --------------------------------------------------------------------------------------------

def write(cases: list[dict], path: Path, *, suites: list[str], categories: list[str], suite_agent: dict,
          thresholds: dict, notes: list[str], prod_present: bool, sources_text: dict) -> None:
    generated = dt.date.today().isoformat()
    report = Report()
    report.header_footer(generated)
    doc = report.doc

    by_suite = Counter(c["suite"] for c in cases)
    by_cat = Counter(c["category"] for c in cases)
    by_sev = Counter(c["severity"] for c in cases)
    prod = [c for c in cases if c["case_id"].startswith("prod-")]
    runnable = [c for c in cases if c["harness"].get("example")]
    adversarial = sum(1 for c in cases if c["category"] == "injection guard")

    # Cover
    band = doc.add_table(rows=1, cols=1)
    fixed_layout(band, [CONTENT_WIDTH])
    shade(band.cell(0, 0), NAVY)
    cell_margins(band, top=160, bottom=160, left=240, right=240)
    band_text = band.cell(0, 0).paragraphs[0]
    band_text.add_run("EVALUATION DATASET  |  LANGGRAPH AGENTS")
    style_runs(band_text, size=9, colour="FFFFFF", bold=True)
    for _ in range(5):
        doc.add_paragraph()
    doc.add_paragraph(PRODUCT).runs[0].font.size = Pt(14)
    style_runs(doc.paragraphs[-1], colour=ACCENT, bold=True)
    title = doc.add_paragraph(TITLE)
    style_runs(title, size=30, colour=NAVY, bold=True)
    title.paragraph_format.space_after = Pt(4)
    subtitle = doc.add_paragraph("Regression cases for the migration agent, mined from the project's development "
                                 "and production history and mapped one-to-one onto the offline eval harness.")
    style_runs(subtitle, size=12, colour=MUTED)
    paragraph_border(subtitle, "bottom", RULE, size=6, space=10)
    doc.add_paragraph()

    kpis = [(str(len(cases)), "Cases"), (str(len(by_suite)), "Harness suites"),
            (str(by_sev["blocker"]), "Release blockers"), (str(adversarial), "Guard / injection cases")]
    kpi = doc.add_table(rows=2, cols=4)
    fixed_layout(kpi, [Cm(4.25)] * 4)
    table_borders(kpi, outer=False)
    for c, (value, label) in enumerate(kpis):
        top, bottom = kpi.cell(0, c), kpi.cell(1, c)
        for cell in (top, bottom):
            shade(cell, PANEL)
        cell_borders(top, top=ACCENT)
        top.paragraphs[0].add_run(value)
        style_runs(top.paragraphs[0], size=24, colour=NAVY, bold=True)
        bottom.paragraphs[0].add_run(label)
        style_runs(bottom.paragraphs[0], size=9, colour=MUTED)
    cell_margins(kpi, top=80, bottom=80, left=160, right=160)
    for _ in range(4):
        doc.add_paragraph()

    control = [["Document control", ""],
               ["Document", f"{TITLE} (docs/eval-dataset/Agent_Offline_Regression_Eval_Dataset.docx)"],
               ["Version", VERSION],
               ["Generated", f"{generated} by docs/eval-dataset/build_dataset.py"],
               ["Machine-readable form", "docs/eval-dataset/agent_eval_dataset.jsonl, harness/<suite>.jsonl"],
               ["Status", "Proposed extension to the deploy eval gate; not yet run against the live agents"],
               ["Classification", "Internal. Synthetic or redacted content only: no customer data, end-user names, "
                                  "emails, NHI numbers, tokens or keys"]]
    table = report.table(control, [Cm(4.2), Cm(12.8)], font=8.5, zebra=False, bold_first_col=True)
    table.cell(0, 0).merge(table.cell(0, 1))

    doc.add_section(WD_SECTION.NEW_PAGE)
    contents_anchor = report.contents_placeholder()
    note = doc.add_paragraph("Page numbers are filled in by Word when the document is opened "
                             "(accept the prompt to update fields).", style="Note")
    note.paragraph_format.space_before = Pt(8)

    # 1 Executive summary
    report.heading("1. Executive summary", 1, page_break=True)
    report.text(f"This dataset turns every agent-behaviour failure recorded in the project's history into a "
                f"regression case that the existing LangGraph eval harness can replay offline. It holds {len(cases)} "
                f"cases across {len(by_suite)} harness suites and {len(by_cat)} behaviour categories; "
                f"{len(runnable)} of them run offline today.")
    report.bullets([
        ("What each case contains: ", "the conversation so far, the user message under test, the expected "
         "behaviour in plain English, machine-checkable pass criteria, and the incident or commit it guards."),
        ("How it is scored: ", "with the thresholds already used by the deploy gate (evals/thresholds.json), "
         "averaging two runs per case. Crashes, fabricated reports, active content and invalid SQL fail on any "
         "occurrence."),
        ("How to run it: ", "one command from services/ai-service (section 3). Nothing reaches the real backend, "
         "database or LangSmith; only the model under test is called."),
        ("Severity: ", f"{by_sev['blocker']} blockers (release-blocking regressions of a production incident), "
         f"{by_sev['major']} major and {by_sev['minor']} minor cases."),
    ], lead=True)
    report.callout("Headline regression guarded",
                   "enrolment-give-me-the-model-sql: asked 'give me the model sql' for an enrolment error model, the "
                   "agent must deliver a statically valid enrolment_errors.sql and must never show internal retry "
                   "instructions. In production (2026-09-23) the author returned no usable draft on all three attempts; "
                   "fixed in 616f5e7.")

    # 2 Purpose and scope
    report.heading("2. Purpose and scope", 1)
    report.heading("2.1 Sources", 2)
    report.bullets(sources_text["sources"] + ([f"A redacted production chat corpus ({len(prod)} cases, prefixed prod-)."]
                                              if prod else [sources_text["no_prod"]]))
    report.heading("2.2 Relationship to the existing suites", 2)
    report.text(sources_text["relationship"])
    report.heading("2.3 Agents under test", 2)
    report.table([["Harness suite", "Agent / pipeline", "Cases"]]
                 + [[s, suite_agent[s], by_suite.get(s, 0)] for s in suites]
                 + [["Total", "", len(cases)]],
                 [Cm(3.4), Cm(11.4), Cm(2.2)], mono_cols=(0,), align_right=(2,), total_row=True)

    # 3 How to run
    report.heading("3. Running the evaluation offline", 1)
    report.text("Offline means local mode: the harness runs the production LangGraph turn graph, agents, prompts and "
                "guardrails in-process against the synthetic backend gateway (evals/gateway.py). Nothing reaches the "
                "real backend, the database or LangSmith. The agents still call the model under test (GPT-OSS 120B on "
                "Bedrock), so AWS_BEARER_TOKEN_BEDROCK must be set; the deterministic evaluators need no network.")
    report.heading("3.1 Dataset runner (recommended)", 2)
    report.code(["cd services/ai-service",
                 "pip install -r requirements-dev.txt",
                 "RUN=../../docs/eval-dataset/run_offline.py",
                 "python $RUN --list",
                 "python $RUN --gate --repetitions 2",
                 "python $RUN --suite history,generation --gate --repetitions 2",
                 "python $RUN --case enrolment-give-me-the-model-sql --repetitions 4",
                 "python $RUN --with-existing --gate --repetitions 2"])
    report.table([["Command", "Purpose"],
                  ["--list", "Show the cases per suite without calling a model."],
                  ["--gate --repetitions 2", "All suites, scored exactly as the deploy gate scores them."],
                  ["--suite / --case", "Run a subset while investigating a regression."],
                  ["--with-existing", "Include the 99 existing harness cases in the same run."]],
                 [Cm(5.0), Cm(12.0)], mono_cols=(0,))
    report.text("run_offline.py points evals.suites at docs/eval-dataset/harness/<suite>.jsonl, adds the "
                "dataset-extension evaluators in section 5.2, merges their thresholds into evals/thresholds.json for "
                "the run only, and calls evals.run's own entry point with --no-upload. Other flags pass through "
                "unchanged, and no file under services/ is modified.")
    report.heading("3.2 Stock harness", 2)
    report.code(["cat docs/eval-dataset/harness/history.jsonl \\",
                 "    >> services/ai-service/evals/datasets/history.jsonl",
                 "cd services/ai-service",
                 "python -m evals.run --suite history --no-upload --gate --repetitions 2"])
    report.text("Every line in harness/<suite>.jsonl is already in the harness example shape ({inputs, outputs, "
                "metadata.case_id}) and uses its conventions: @fixture:NAME references into evals/fixtures.py, "
                "@response:N substitution of earlier replies, and backend stand-ins for uploads, chat search, file "
                "fetch and GitHub. Keys the stock evaluators do not know are ignored there, so appending is safe; only "
                "run_offline.py scores them.")
    report.heading("3.3 Loading the JSONL directly", 2)
    report.code(["import json",
                 "path = 'docs/eval-dataset/agent_eval_dataset.jsonl'",
                 "cases = [json.loads(line) for line in open(path) if line.strip()]",
                 "history = [c['harness']['example'] for c in cases if c['suite'] == 'history']",
                 "from evals.suites import SUITES; from evals.harness import run_local",
                 "run = await run_local(SUITES['history'], history, concurrency=4, repetitions=2)"])
    report.heading("3.4 Regenerating this document", 2)
    report.code(["python docs/eval-dataset/build_dataset.py",
                 "python docs/eval-dataset/build_dataset.py --prod-corpus cases.json"])
    report.text("mined_scenarios.json is the curated source: edit a scenario there, then rebuild. The build validates "
                "required fields, unique ids and inputs, suite-specific shapes and regexes, and refuses to write if it "
                "finds an email (other than example domains), an NHI-shaped value, a secret-shaped token or a real "
                "person's name.")

    # 4 Coverage
    report.heading("4. Coverage", 1)
    report.heading("4.1 Agent by category", 2)
    cats = [c for c in categories if by_cat.get(c)]
    matrix = defaultdict(Counter)
    for c in cases:
        matrix[c["suite"]][c["category"]] += 1
    rows = [["Agent"] + [SHORT_CATEGORY[c] for c in cats] + ["Total"]]
    for suite in suites:
        rows.append([SHORT_AGENT[suite]] + [matrix[suite].get(c) or "" for c in cats] + [sum(matrix[suite].values())])
    rows.append(["Total"] + [by_cat[c] for c in cats] + [len(cases)])
    first, last = Cm(2.9), Cm(1.2)
    rest = Cm(round((17.0 - 2.9 - 1.2) / len(cats), 2))
    matrix_table = report.table(rows, [first] + [rest] * len(cats) + [last], font=7.5,
                                align_right=tuple(range(1, len(cats) + 2)), bold_first_col=True, total_row=True)
    for c in range(1, len(cats) + 2):
        matrix_table.cell(0, c).paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    report.text("Migration build = Requirements Analyst, Model Author (fan-out) and Model Reviewer. Impact pipeline = "
                "Evidence Investigator and Impact Reporter. Memory = Migration Consultant remember/forget plus the "
                "capture_memory step.", style="Note")
    report.heading("4.2 Severity", 2)
    report.table([["Severity", "Cases", "Meaning"],
                  ["Blocker", by_sev["blocker"], "Release-blocking regression of a production incident or a hard rule "
                                                 "(file or SQL not delivered, attack passed, benign user blocked)."],
                  ["Major", by_sev["major"], "Wrong or degraded behaviour a user would notice; tracked against the "
                                             "suite rate."],
                  ["Minor", by_sev["minor"], "Wording or robustness; informative, not gating on its own."]],
                 [Cm(2.6), Cm(1.6), Cm(12.8)], align_right=(1,), bold_first_col=True)
    report.text(f"Harness-runnable offline: {len(runnable)} of {len(cases)} cases.", bold_lead=None)

    # 5 Scoring
    report.heading("5. Scoring and thresholds", 1)
    report.text("Scoring follows evals/thresholds.json exactly. The deploy gate runs every case twice and averages "
                "(--repetitions 2): single runs vary, so a one-off miss must not block a release while a systematic "
                "regression still does. Hard zeros stay hard: a crash, a fabricated impact report or one written "
                "without reading evidence, active content in a reply, and SQL that fails static validation fail the "
                "gate on any occurrence.")
    report.heading("5.1 Gate thresholds", 2)
    rows = [["Suite", "Feedback key", "Gate"]]
    for suite in ["*"] + suites:
        for key, rule in (thresholds.get(suite) or {}).items():
            rows.append(["all suites" if suite == "*" else suite, key,
                         f"≥ {rule['min']}" if "min" in rule else f"≤ {rule['max']}"])
    report.table(rows, [Cm(3.6), Cm(9.4), Cm(4.0)], font=8.5, mono_cols=(1,))
    report.heading("5.2 Dataset-extension evaluators", 2)
    report.text("A few regressions need checks the stock evaluators do not make. run_offline.py adds these only for "
                "cases whose reference carries the key. Their gates are proposals, not yet calibrated against repeated "
                "live runs; calibrate them as thresholds.json was (two runs, set just below measured reliability) "
                "before wiring them into CI.")
    report.table([["Reference key", "Feedback key", "Proposed gate", "What it checks"],
                  ["must_contain / must_not_contain", "mentions_required / avoids_forbidden", "≥ 0.9 / = 1.0",
                   "Final reply text, for example that the internal retry instruction is never shown."],
                  ["must_contain_any", "mentions_any", "≥ 0.75", "Each group: at least one alternative appears."],
                  ["expect_no_files", "no_unrequested_files", "= 1.0", "No file card on the final turn."],
                  ["max_files", "file_cap", "= 1.0", "At most N files attached (delivery cap of three)."],
                  ["asks_clarification", "asks_clarification", "≥ 0.9", "The reply asks the user a question."],
                  ["not_blocked", "not_blocked", "= 1.0", "No turn in the conversation was blocked by guardrails."]],
                 [Cm(4.2), Cm(4.2), Cm(2.4), Cm(6.2)], font=8.5, mono_cols=(0, 1))
    report.heading("5.3 Reading a result", 2)
    report.bullets([
        "A case passes when every feedback key it produces meets its gate; a suite passes when the mean of each key "
        "across its cases and both repetitions meets the gate.",
        "A blocker failing in both repetitions is a regression of the incident in its 'Guards against' field, even if "
        "the suite mean still passes. Use --report to write per-case results to JSON.",
        "LLM-as-judge keys (correctness, groundedness) use GPT-OSS 120B as judge; a judge outage yields a missing "
        "score, not a failure.",
    ])

    # 6 Catalogue
    report.heading("6. Case catalogue", 1, page_break=True)
    report.text("Every case at a glance, in the order of section 7. Severity drives how a failure is treated "
                "(section 4.2).")
    rows = [["#", "Case ID", "Suite", "Category", "Severity"]]
    numbering: dict[str, str] = {}
    for s_index, suite in enumerate(suites, 1):
        group = [c for c in cases if c["suite"] == suite]
        for c_index, case in enumerate(group, 1):
            number = f"7.{s_index}.{c_index}"
            numbering[case["case_id"]] = number
            rows.append([number, case["case_id"], suite, case["category"], case["severity"].capitalize()])
    catalogue = report.table(rows, [Cm(1.6), Cm(7.4), Cm(2.4), Cm(3.6), Cm(2.0)], font=8, mono_cols=(1,))
    for r in range(1, len(rows)):
        severity = rows[r][4].lower()
        style_runs(catalogue.cell(r, 4).paragraphs[0], colour=SEVERITY_COLOUR[severity], bold=True)

    # 7 Case specifications
    report.heading("7. Case specifications", 1, page_break=True)
    report.text("Grouped by harness suite. A prior turn shown as <live reply ...> is produced by the agent during the "
                "run and replayed as history by the harness, as the backend does in production.")
    for s_index, suite in enumerate(suites, 1):
        group = [c for c in cases if c["suite"] == suite]
        if not group:
            continue
        report.heading(f"7.{s_index} {SHORT_AGENT[suite]} ({suite}, {len(group)} cases)", 2, page_break=s_index > 1)
        for case in group:
            case_card(report, numbering[case["case_id"]], case, suite_agent[suite])

    # 8 Gaps
    report.heading("8. Known gaps and limitations", 1, page_break=True)
    report.bullets(sources_text["gaps"] + ([f"Production corpus: {n}" for n in notes] if notes else [])
                   + ([] if prod_present else ["The redacted production chat corpus was not present at build time; "
                                               "rebuild with --prod-corpus to include it."]))

    # Appendix
    report.heading("Appendix A. Case field reference", 1)
    report.table([["Field", "Meaning"],
                  ["case_id", "Stable identifier; unique across this dataset and the existing harness datasets."],
                  ["suite / agent / category", "Harness suite that runs the case, the agent it exercises, and the "
                                               "behaviour category used in the coverage matrix."],
                  ["severity", "blocker, major or minor (section 4.2)."],
                  ["turns", "Conversation replayed as history before the message under test."],
                  ["input", "The final user message the agent is scored on."],
                  ["attached_files", "Files present in the chat, mapped to evals/fixtures.py fixtures."],
                  ["expected_behaviour", "What a correct agent does, in plain English."],
                  ["reference_outputs", "Machine-checkable pass criteria read by the evaluators; identical to "
                                        "harness.example.outputs."],
                  ["evaluators", "Evaluator functions (and summary evaluators) that score the case."],
                  ["regression_of", "The incident, bug or commit the case guards against."],
                  ["source", "Where the case was mined from: development session, date, commit, note."],
                  ["harness", "{suite, example} block in the exact shape evals.run loads; example is null for "
                              "review-only production records."]],
                 [Cm(4.2), Cm(12.8)], font=8.5, mono_cols=(0,))

    report.fill_contents(contents_anchor)
    report.update_fields_on_open()
    report.save(path)
