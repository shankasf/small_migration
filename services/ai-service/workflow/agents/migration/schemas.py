"""Typed results passed between the migration agents."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
                                          "joins; filters and macros; CASE code lists; numeric precision/scale; "
                                          "every key of a nested JSON/VARIANT/OBJECT payload with its source")
    decisions: list[str] = Field(default_factory=list,
                                 description="Each answer the user gave, paired with the question it answers and "
                                             "the exact fields or refs it applies to, e.g. 'Q4 TBD fields "
                                             "(Entitlement Type, Practitioner ID): user said leave as TBD'")
    placeholders: list[str] = Field(default_factory=list,
                                    description="Target fields (or JSON key paths / ref names) the user EXPLICITLY "
                                                "allowed to be a placeholder, NULL or 'TBD'. Every other mapped "
                                                "field must be implemented from its source")


class ModelDraft(BaseModel):
    """One complete SQL file from the author, separate from its explanation."""

    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    sql: str = Field(min_length=1, description="The complete raw dbt SQL model. No Markdown fences or explanation.")
    notes: str = Field(default="", max_length=4000,
                       description="Optional short notes about the model; never include SQL here.")

    @field_validator("sql")
    @classmethod
    def raw_sql_only(cls, value: str) -> str:
        if value.startswith(("```", "~~~")):
            raise ValueError("sql must contain raw SQL, without Markdown fences")
        return value


class ModelReview(BaseModel):
    """The Model Reviewer's verdict on one generated model."""

    approved: bool = Field(description="True only when no defects remain")
    issues: list[str] = Field(description="Concrete defects, one sentence each, naming the field/CTE and the fix")
