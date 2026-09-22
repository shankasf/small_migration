"""Typed results passed between the migration agents."""
from __future__ import annotations

from pydantic import BaseModel, Field

# Output names end up in download cards and a storage key, so they are plain
# file names: no directories, no parent references, no absolute paths.
SAFE_FILE_NAME = r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$"


class ModelTarget(BaseModel):
    file_name: str = Field(pattern=SAFE_FILE_NAME, max_length=128,
                           description="Output file name, e.g. stg_contracts.sql")
    purpose: str = Field(description="What this model produces, in one sentence")
    revision_of: str = Field(default="", description="Existing file name when revising a model; empty for a new model")


class MigrationSpec(BaseModel):
    """The Requirements Analyst's build specification."""

    ready: bool = Field(description="True only when nothing blocking is unclear")
    findings: str = Field(description="User-facing analysis: template findings, mapping review, flagged issues")
    questions: list[str] = Field(description="Blocking clarifying questions; empty when ready")
    targets: list[ModelTarget] = Field(description="Model files to create or revise; empty when not ready")
    requirements: str = Field(description="Complete raw build facts for the authors: every field with source "
                                          "expression, datatype, nullability and default; base ref model; CTEs; "
                                          "joins; filters and macros; CASE code lists; numeric precision/scale")


class ModelReview(BaseModel):
    """The Model Reviewer's verdict on one generated model."""

    approved: bool = Field(description="True only when no defects remain")
    issues: list[str] = Field(description="Concrete defects, one sentence each, naming the field/CTE and the fix")
