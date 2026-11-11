"""Typed results passed between the impact agents."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


UNANSWERED = "Not answered: the evidence read for this analysis does not settle this question."
NO_ANSWER = "I could not produce an answer from the evidence read for this analysis."


class EvidenceItem(BaseModel):
    source: str = Field(description="Confirmed source category the evidence came from")
    locator: str = Field(description="Exact locator: file path and line, dbt node ID, commit SHA, run ID or version")
    excerpt: str = Field(description="Verbatim evidence text")


class Coverage(BaseModel):
    question: str = Field(description="One of the user's questions, in a few words, in their order")
    evidence: list[str] = Field(description="Locators (path:line) of the evidence that answers it")
    open: str = Field(description="What is still unknown for this question and which file would settle it; "
                                  "empty when the evidence answers it")


class EvidenceDossier(BaseModel):
    """What the Evidence Investigator established from the confirmed sources."""

    ready: bool = Field(description="False when the target, the change or the right artifact version is unclear")
    change_kind: Literal["model_sql", "seed_or_source_data", "config_or_yaml", "other"] = Field(
        default="other", description="What the proposed change edits: model SQL, seed or source data, project "
                                     "config/YAML, or something else")
    changed_file: str = Field(default="", description="Path of the file the change edits, e.g. seeds/pharma/drugs.csv")
    coverage: list[Coverage] = Field(default_factory=list,
                                     description="Every question the user asked, with the evidence that answers it")
    missing_information: str = Field(description="Only when ready is false: the questions or artifacts needed")
    evidence: list[EvidenceItem] = Field(description="Every relevant fact, cited")
    lineage_notes: str = Field(description="Upstream/downstream paths traced, by node or file")
    unverified: str = Field(description="What could not be verified and which artifact would settle it")


class Answer(BaseModel):
    """One of the user's questions and its direct answer, in the order they asked."""

    question: str
    answer: str


class ImpactReport(BaseModel):
    """A reply shaped like the user's questions, not like a report template.

    Practitioners read fixed sections with a confidence label on every line as
    an audit report rather than an answer, so the contract is: answer what was
    asked, in order, once.
    """

    ready: bool
    missing_information: str
    answers: list[Answer]
    critical_warnings: str
    gaps: str

    def markdown(self) -> str:
        if not self.ready:
            return self.missing_information.strip() or NO_ANSWER
        # A question left blank is said to be unanswered, never silently dropped.
        blocks = [f"### {n}. {answer.question.strip()}\n\n{answer.answer.strip() or UNANSWERED}"
                  for n, answer in enumerate(self.answers, 1) if answer.question.strip() or answer.answer.strip()]
        if not blocks:
            blocks.append(NO_ANSWER)
        if self.critical_warnings.strip():
            blocks.append("### Watch out\n\n" + self.critical_warnings.strip())
        if self.gaps.strip():
            blocks.append("**Gaps:** " + self.gaps.strip())
        return "\n\n".join(blocks)
