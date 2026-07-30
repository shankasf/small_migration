"""
Generate Agentic AI Approach Document for Comparison Testing & Data Migration Testing
"""

from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn, nsdecls
from docx.oxml import parse_xml
from pathlib import Path
import os

doc = Document()

# ── Page margins ──
for section in doc.sections:
    section.top_margin = Cm(2)
    section.bottom_margin = Cm(2)
    section.left_margin = Cm(2.5)
    section.right_margin = Cm(2.5)

# ── Styles ──
style = doc.styles['Normal']
font = style.font
font.name = 'Calibri'
font.size = Pt(11)
font.color.rgb = RGBColor(0x33, 0x33, 0x33)
style.paragraph_format.space_after = Pt(6)
style.paragraph_format.line_spacing = 1.15

# Helper functions
def add_heading_styled(text, level=1):
    h = doc.add_heading(text, level=level)
    for run in h.runs:
        run.font.color.rgb = RGBColor(0x1A, 0x3C, 0x6E)
    return h

def add_bullet(text, bold_prefix=None):
    p = doc.add_paragraph(style='List Bullet')
    if bold_prefix:
        run = p.add_run(bold_prefix)
        run.bold = True
        p.add_run(text)
    else:
        p.add_run(text)
    return p

def set_cell_shading(cell, color):
    shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{color}"/>')
    cell._tc.get_or_add_tcPr().append(shading)

def add_styled_table(headers, rows):
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    # Header row
    for i, header in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = header
        for paragraph in cell.paragraphs:
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for run in paragraph.runs:
                run.bold = True
                run.font.size = Pt(10)
                run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        set_cell_shading(cell, "1A3C6E")

    # Data rows
    for r_idx, row in enumerate(rows):
        for c_idx, val in enumerate(row):
            cell = table.rows[r_idx + 1].cells[c_idx]
            cell.text = val
            for paragraph in cell.paragraphs:
                for run in paragraph.runs:
                    run.font.size = Pt(10)
            if r_idx % 2 == 0:
                set_cell_shading(cell, "F0F4FA")

    return table


# ════════════════════════════════════════════════
# TITLE PAGE
# ════════════════════════════════════════════════

doc.add_paragraph()
doc.add_paragraph()

title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = title.add_run("Agentic AI Approach")
run.bold = True
run.font.size = Pt(28)
run.font.color.rgb = RGBColor(0x1A, 0x3C, 0x6E)

subtitle = doc.add_paragraph()
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = subtitle.add_run("Comparison Testing & Data Migration Testing")
run.font.size = Pt(16)
run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)

doc.add_paragraph()

# Metadata
meta = doc.add_paragraph()
meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
meta.add_run("Project: ").bold = True
meta.add_run("Circini Migration Agent (DBT / Snowflake)\n")
meta.add_run("Date: ").bold = True
meta.add_run("12 March 2026\n")
meta.add_run("Status: ").bold = True
meta.add_run("High-Level Approach Document")

doc.add_page_break()

# ════════════════════════════════════════════════
# 1. EXECUTIVE SUMMARY
# ════════════════════════════════════════════════

add_heading_styled("1. Executive Summary", level=1)

doc.add_paragraph(
    "This document outlines a high-level approach for leveraging Agentic AI capabilities "
    "in two key testing workflows within the data migration programme:"
)

add_bullet("Comparison Testing — ", bold_prefix="")
p = doc.paragraphs[-1]
p.clear()
run = p.add_run("Comparison Testing: ")
run.bold = True
p.add_run("Validating whether AI-generated mapping documents accurately reflect the existing verified DBT SQL code")

add_bullet("", bold_prefix="")
p = doc.paragraphs[-1]
p.clear()
run = p.add_run("Data Migration Testing: ")
run.bold = True
p.add_run("Ensuring migrated data is complete, accurate, and conforms to target system requirements")

doc.add_paragraph(
    "The approach builds on the existing Circini Migration Agent and the recent testing sessions "
    "conducted with the team, where we validated the AI's ability to reverse-engineer mapping documents from SQL code."
)

# ════════════════════════════════════════════════
# 2. CURRENT STATE
# ════════════════════════════════════════════════

add_heading_styled("2. Current State — What We Have Done", level=1)

doc.add_paragraph(
    "In our recent working session (March 2026), we tested the Circini Migration Agent's "
    "capability to understand and extract structured information from existing DBT SQL models."
)

add_heading_styled("2.1 Testing Workflow Executed", level=2)

doc.add_paragraph(
    "The following steps were performed to validate the AI agent's accuracy:"
)

steps = [
    ("Step 1 — Input: ", "Uploaded two verified, production-ready DBT SQL models into the AI agent: "
     "the transformation model (Add_Info UC2 V3) and the staging model (Stg_Add_Info UC2 V3)."),
    ("Step 2 — AI Processing: ", "The AI agent parsed the SQL code and automatically generated a structured "
     "mapping document (Excel format) — extracting field names, data types, source database/schema/table, "
     "source columns, transformation logic (CASE statements, joins, defaults), and mapping rules."),
    ("Step 3 — Manual Comparison: ", "The team manually compared the AI-generated mapping document against "
     "the known-correct, approved mapping document to verify accuracy — checking field-by-field whether "
     "the AI correctly captured the source-to-target mappings, transformation rules, and data types."),
]

for prefix, text in steps:
    p = doc.add_paragraph()
    run = p.add_run(prefix)
    run.bold = True
    run.font.color.rgb = RGBColor(0x1A, 0x3C, 0x6E)
    p.add_run(text)

add_heading_styled("2.2 Key Observations", level=2)

add_bullet("The AI agent successfully parsed complex DBT SQL with 50+ fields, multiple CTEs, CASE logic, and multi-table joins")
add_bullet("The generated mapping document captured field names, types, and transformation rules with high accuracy")
add_bullet("The comparison step was done manually, which is time-consuming and error-prone for large data objects")
add_bullet("The manual comparison is the bottleneck — this is where agentic AI can add the most value")

# ════════════════════════════════════════════════
# 3. COMPARISON TESTING — AGENTIC AI APPROACH
# ════════════════════════════════════════════════

doc.add_page_break()
add_heading_styled("3. Comparison Testing — Agentic AI Approach", level=1)

doc.add_paragraph(
    "The goal is to automate the manual comparison step that currently requires a human to open "
    "both mapping documents side-by-side and check each field one by one."
)

add_heading_styled("3.1 Proposed Workflow", level=2)

add_styled_table(
    ["Step", "Current (Manual)", "Proposed (Agentic AI)"],
    [
        ["1. Generate mapping\nfrom SQL",
         "AI agent parses SQL and produces a mapping document",
         "Same — no change (already working)"],
        ["2. Compare against\nknown-correct mapping",
         "Human opens both files side-by-side and checks each field manually",
         "Agent takes both mappings as input and performs automated field-by-field diff"],
        ["3. Identify\ndiscrepancies",
         "Human spots differences through visual inspection",
         "Agent flags exact mismatches: wrong source column, missing transform rule, type mismatch, incorrect default value"],
        ["4. Report findings",
         "Human writes up findings manually",
         "Agent produces structured diff report with pass/fail per field and mismatch details"],
    ]
)

doc.add_paragraph()
add_heading_styled("3.2 How the Comparison Agent Works", level=2)

doc.add_paragraph(
    "The Comparison Agent is an extension of the existing Circini Migration Agent, equipped with "
    "additional tools for structured document comparison:"
)

comparison_steps = [
    ("Ingest: ", "Agent receives two inputs — (a) the AI-generated mapping and (b) the known-correct approved mapping document."),
    ("Parse: ", "Agent normalises both documents into a common structure — field name, data type, source table, source column, transformation rule, default value."),
    ("Diff: ", "Agent performs a field-by-field comparison across all columns, flagging: exact matches, partial matches (e.g. different wording but same logic), and mismatches."),
    ("Report: ", "Agent produces a structured comparison report — showing each field's status (Pass/Fail), the expected vs actual value, and the nature of the discrepancy."),
    ("Suggest: ", "For each mismatch, the agent traces back to the SQL code to explain why the difference occurred and suggests whether the AI logic or the mapping needs correction."),
]

for prefix, text in comparison_steps:
    p = doc.add_paragraph()
    run = p.add_run(prefix)
    run.bold = True
    run.font.color.rgb = RGBColor(0x1A, 0x3C, 0x6E)
    p.add_run(text)

add_heading_styled("3.3 Example Output", level=2)

add_styled_table(
    ["Field Name", "Attribute", "Expected (Correct)", "AI Generated", "Status"],
    [
        ["division", "Source Table", "mdm_division", "mdm_division", "✓ Pass"],
        ["contract_type", "Transform Rule", "Join on CTYPEID +\ntransitionalfunder", "Join on CTYPEID only", "✗ Fail"],
        ["send_reminder_alert", "Default Value", "'N'", "'Contract Manager'", "✗ Fail"],
        ["operating_group_code", "Conditional Logic", "NULL when MDP", "No MDP exclusion", "✗ Fail"],
        ["region_code", "Join Condition", "dhbcode +\ntransitionalfunder", "concat(funder.dhbcode)", "✗ Fail"],
    ]
)

# ════════════════════════════════════════════════
# 4. DATA MIGRATION TESTING — AGENTIC AI APPROACH
# ════════════════════════════════════════════════

doc.add_page_break()
add_heading_styled("4. Data Migration Testing — Agentic AI Approach", level=1)

doc.add_paragraph(
    "Beyond comparing mapping documents, the agentic AI approach can be extended to validate "
    "the actual migrated data in Snowflake — ensuring completeness, accuracy, and conformity "
    "to the target template requirements."
)

add_heading_styled("4.1 Test Categories", level=2)

add_styled_table(
    ["Test Category", "What It Validates", "Example"],
    [
        ["Row Completeness",
         "All in-scope records migrated",
         "148 in_scope_contracts → 148 rows in target (not 412 from join duplication)"],
        ["Field Accuracy",
         "Transformation rules applied correctly",
         "contract_type should come from mdm_contract_type lookup, not raw CTYPEID"],
        ["Default Validation",
         "Correct defaults per business rule",
         "send_reminder_alert = 'N', not 'Contract Manager' from ambiguous mapping"],
        ["NULL Conformity",
         "NOT NULL fields have values",
         "division defaults to 'Not in CMS' when source is NULL"],
        ["Referential Integrity",
         "Lookups and joins resolve correctly",
         "region_code from mdm joined on (dhbcode, transitionalfunder)"],
        ["Type Conformity",
         "Output types match template spec",
         "Boolean fields output as 'Yes'/'No' VARCHAR, not TRUE/FALSE"],
    ]
)

doc.add_paragraph()
add_heading_styled("4.2 How the Data Migration Test Agent Works", level=2)

migration_steps = [
    ("1. Auto-Generate Test Cases: ",
     "Agent reads the mapping document and target template, then automatically generates "
     "validation queries — NULL checks, type checks, row counts, value distribution checks, "
     "and referential integrity checks. No manual test script writing needed."),
    ("2. Compare Code vs Spec: ",
     "Agent compares the actual DBT SQL code against the approved mapping document to detect "
     "any drift — fields missing, transforms changed, defaults altered."),
    ("3. Execute & Validate: ",
     "With Snowflake connectivity (planned), the agent can run the generated validation queries "
     "directly and report pass/fail results per test case."),
    ("4. Regression Testing: ",
     "When a model is regenerated or modified, the full test suite re-runs automatically — "
     "ensuring no regressions are introduced."),
]

for prefix, text in migration_steps:
    p = doc.add_paragraph()
    run = p.add_run(prefix)
    run.bold = True
    run.font.color.rgb = RGBColor(0x1A, 0x3C, 0x6E)
    p.add_run(text)

# ════════════════════════════════════════════════
# 5. BENEFITS
# ════════════════════════════════════════════════

doc.add_page_break()
add_heading_styled("5. Benefits of the Agentic AI Approach", level=1)

add_styled_table(
    ["Benefit", "Description"],
    [
        ["Speed",
         "Mapping comparison and validation in minutes instead of hours of manual review"],
        ["Accuracy",
         "Every field checked systematically — eliminates human oversight risk on large data objects (50+ fields)"],
        ["Traceability",
         "Each discrepancy is linked back to the exact mapping row, SQL line, and business rule"],
        ["Reusability",
         "Same agent and approach works for any data object — AdditionalInfo, Staged_Contract, or any future use case. Just provide the SQL and mapping."],
        ["Consistency",
         "Standardised comparison criteria applied uniformly — no variation based on who performs the review"],
        ["Scalability",
         "As the number of data objects and migration use cases grows, the testing effort stays flat — the agent handles the volume"],
        ["Faster Iterations",
         "When issues are found and SQL is regenerated, the comparison re-runs instantly — tightening the feedback loop"],
    ]
)

# ════════════════════════════════════════════════
# 6. IMPLEMENTATION ROADMAP
# ════════════════════════════════════════════════

doc.add_paragraph()
add_heading_styled("6. Implementation Roadmap", level=1)

add_styled_table(
    ["Phase", "Scope", "Description"],
    [
        ["Phase 1\n(Immediate)",
         "Automated Mapping Comparison",
         "Extend the existing Circini Migration Agent to accept two mapping documents and produce a structured diff report — automating the manual comparison we currently do by hand"],
        ["Phase 2\n(Short-term)",
         "Code-vs-Spec Validation",
         "Agent compares DBT SQL code against the approved mapping document to detect drift — missing fields, changed transforms, altered defaults"],
        ["Phase 3\n(Medium-term)",
         "Snowflake Data Validation",
         "Add Snowflake query execution capability — agent runs validation queries against actual migrated data and reports completeness, accuracy, and conformity"],
        ["Phase 4\n(Future)",
         "CI/CD Integration",
         "Comparison and data validation tests run automatically on every DBT model change as part of the deployment pipeline"],
    ]
)

# ════════════════════════════════════════════════
# 7. SUMMARY
# ════════════════════════════════════════════════

doc.add_paragraph()
add_heading_styled("7. Summary", level=1)

doc.add_paragraph(
    "The agentic AI approach extends our current Circini Migration Agent from code generation "
    "into a full generate → compare → validate → report loop. The immediate value is automating "
    "the manual mapping comparison that currently takes significant effort per data object. "
    "The longer-term vision connects the agent directly to Snowflake for end-to-end data migration "
    "validation — from mapping accuracy through to actual data quality in the target system."
)

doc.add_paragraph()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run("— End of Document —")
run.italic = True
run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

# ── Save ──
output_path = str(
    Path(__file__).resolve().parent.parent
    / "Agentic_AI_Approach_Comparison_and_Migration_Testing.docx"
)
doc.save(output_path)
print(f"Document saved to: {output_path}")
