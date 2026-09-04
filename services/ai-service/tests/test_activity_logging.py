"""
Activity-logging tests.

The admin portal's AI log is the record of what the agent did on a user's
behalf — tool calls, model calls, token counts and outputs. These tests pin the
two properties that make that record trustworthy: every event carries the turn
and user identity the backend assigned, and no payload reaches the log without
being truncated and guardrail-filtered first.
"""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from utils.realtime_logger import (  # noqa: E402
    PREVIEW_MAX_CHARS,
    RealtimeLogger,
    ToolSpan,
    preview,
)


class CapturingLogger(RealtimeLogger):
    """A logger that records payloads instead of posting them."""

    def __init__(self, **kwargs):
        super().__init__("sess-1", **kwargs)
        self.events = []

    async def log(self, step, message, log_type="info", data=None, **fields):
        self.events.append({"step": step, "message": message, "type": log_type, **fields})


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Identity — every line must be attributable to a user and a turn
# ---------------------------------------------------------------------------

def test_events_carry_turn_and_user_identity():
    logger = RealtimeLogger("sess-1", turn_id="turn-7", user_id="user-42")
    assert logger.turn_id == "turn-7"
    assert logger.user_id == "user-42"


def test_tool_span_logs_call_and_result_with_duration():
    logger = CapturingLogger(turn_id="turn-7", user_id="user-42")

    async def scenario():
        async with ToolSpan(logger, "generate_output", {"file_name": "stg.sql", "content": "select 1"}) as span:
            span.result = "File 'stg.sql' saved (8 characters)."
            return span.result

    assert run(scenario()).startswith("File 'stg.sql' saved")

    call, result = logger.events
    assert call["step"] == "tool.call" and call["tool"] == "generate_output"
    assert "generate_output" in call["message"]
    assert result["step"] == "tool.result" and result["tool"] == "generate_output"
    assert result["duration_ms"] >= 0
    assert result["detail"]["ok"] is True
    assert "saved" in result["detail"]["result"]


def test_tool_span_records_failures_without_swallowing_them():
    logger = CapturingLogger()

    async def scenario():
        async with ToolSpan(logger, "read_file", {"file_name": "x.csv"}):
            raise ValueError("disk on fire")

    with pytest.raises(ValueError):
        run(scenario())

    result = logger.events[-1]
    assert result["step"] == "tool.result"
    assert result["type"] == "error"
    assert result["detail"]["ok"] is False
    assert "disk on fire" in result["detail"]["result"]


def test_llm_call_reports_token_counts():
    logger = CapturingLogger(turn_id="turn-7", user_id="user-42")
    run(logger.llm_call(
        model="gpt-5.2", provider="openai",
        input_tokens=1200, output_tokens=340, duration_ms=910, reasoning_tokens=128,
    ))
    event = logger.events[0]
    assert event["step"] == "llm.call"
    assert event["input_tokens"] == 1200
    assert event["output_tokens"] == 340
    assert event["detail"]["reasoningTokens"] == 128


# ---------------------------------------------------------------------------
# Payload safety — previews are bounded and filtered
# ---------------------------------------------------------------------------

def test_preview_truncates_large_payloads():
    text = preview("x" * (PREVIEW_MAX_CHARS + 5000))
    assert len(text) < PREVIEW_MAX_CHARS + 200
    assert "truncated" in text


def test_preview_filters_sensitive_content():
    # An NHI number is health PII; it must not survive into the activity log.
    filtered = preview("Patient NHI ZZZ0016 attached to the mapping")
    assert "ZZZ0016" not in filtered


def test_preview_serialises_non_strings():
    assert preview({"file_name": "stg.sql"}) == '{"file_name": "stg.sql"}'
