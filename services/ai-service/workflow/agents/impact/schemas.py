"""Typed results passed between the impact agents."""
from __future__ import annotations

from pydantic import BaseModel, Field


class EvidenceItem(BaseModel):
    source: str = Field(description="Confirmed source category the evidence came from")
    locator: str = Field(description="Exact locator: file path and line, dbt node ID, commit SHA, run ID or version")
    excerpt: str = Field(description="Verbatim evidence text")


class EvidenceDossier(BaseModel):
    """What the Evidence Investigator established from the confirmed sources."""

    ready: bool = Field(description="False when the target, the change or the right artifact version is unclear")
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
            return self.missing_information.strip()
        blocks = [f"### {n}. {answer.question.strip()}\n\n{answer.answer.strip()}"
                  for n, answer in enumerate(self.answers, 1) if answer.answer.strip()]
        if self.critical_warnings.strip():
            blocks.append("### Watch out\n\n" + self.critical_warnings.strip())
        if self.gaps.strip():
            blocks.append("**Gaps:** " + self.gaps.strip())
        return "\n\n".join(blocks)
