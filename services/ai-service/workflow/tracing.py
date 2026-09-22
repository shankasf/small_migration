"""LangSmith tracing with content redaction.

Tracing is attached per run through an explicit callback whose client carries
an anonymizer built from the guardrail patterns (NZ health identifiers, IRD,
email, phone, DOB, credentials). Environment-level tracing
(``LANGSMITH_TRACING``) is refused at startup because it would create a second
tracer without that anonymizer.
"""
from __future__ import annotations

import os
from typing import Any

import guardrails
from config import settings

_ENV_TRACING = ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING")


def redaction_rules() -> list[dict[str, Any]]:
    """The guardrail recognisers, compiled (their flags matter, e.g. case-insensitive DOB)."""
    rules = [
        {"pattern": guardrails.NHI_PATTERN, "replace": "[NHI_REDACTED]"},
        {"pattern": guardrails.DOB_PATTERN, "replace": "[DOB_REDACTED]"},
        {"pattern": guardrails.IRD_PATTERN, "replace": "[IRD_REDACTED]"},
        {"pattern": guardrails.EMAIL_PATTERN, "replace": "[EMAIL_REDACTED]"},
        {"pattern": guardrails.PHONE_PATTERN, "replace": "[PHONE_REDACTED]"},
    ]
    return rules + [{"pattern": pattern, "replace": f"[{label.upper()}_REDACTED]"}
                    for label, pattern in guardrails.SECRET_PATTERNS]


class TraceExporter:
    def __init__(self) -> None:
        for name in _ENV_TRACING:
            if os.environ.get(name, "").strip().lower() in ("1", "true", "yes"):
                raise RuntimeError(f"{name} would trace without redaction; use AGENT_TRACING_ENABLED")
        self.enabled = settings.AGENT_TRACING_ENABLED
        self._client = None
        if self.enabled:
            if not settings.LANGSMITH_API_KEY:
                raise RuntimeError("AGENT_TRACING_ENABLED requires LANGSMITH_API_KEY")
            from langsmith import Client
            from langsmith.anonymizer import create_secret_anonymizer
            # LangSmith's own secret detectors, then the application's PII recognisers.
            self._client = Client(api_key=settings.LANGSMITH_API_KEY, api_url=settings.LANGSMITH_ENDPOINT,
                                  anonymizer=create_secret_anonymizer(extra_rules=redaction_rules()))

    def callbacks(self) -> list[Any]:
        if not self.enabled:
            return []
        from langchain_core.tracers.langchain import LangChainTracer
        return [LangChainTracer(client=self._client, project_name=settings.LANGSMITH_PROJECT)]

    def flush(self) -> None:
        if self._client is not None:
            self._client.flush()

    @property
    def destination(self) -> str | None:
        return settings.LANGSMITH_ENDPOINT if self.enabled else None
