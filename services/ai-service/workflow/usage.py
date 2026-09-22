"""Per-call token metering.

Every completed model call emits one ``llm.call`` activity event with its own
token counts, and the totals are returned to the backend for the turn rollup.
The backend's aggregates count only the rollup, so the two never double count.
"""
from __future__ import annotations

import time
from typing import Any
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult


class UsageMeter(AsyncCallbackHandler):
    def __init__(self, logger, *, model: str, provider: str):
        self.logger = logger
        self.model = model
        self.provider = provider
        self.input_tokens = 0
        self.output_tokens = 0
        self.calls = 0
        self._started: dict[UUID, float] = {}

    async def on_chat_model_start(self, serialized: dict[str, Any], messages, *, run_id: UUID, **kwargs: Any) -> None:
        self._started[run_id] = time.monotonic()

    async def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        started = self._started.pop(run_id, time.monotonic())
        usage = _usage(response)
        input_tokens = int(usage.get("input_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
        details = usage.get("output_token_details") or {}
        cached = (usage.get("input_token_details") or {}).get("cache_read") or 0
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.calls += 1
        if self.logger:
            try:
                await self.logger.llm_call(
                    model=self.model, provider=self.provider,
                    input_tokens=input_tokens, output_tokens=output_tokens,
                    duration_ms=int((time.monotonic() - started) * 1000),
                    reasoning_tokens=int(details.get("reasoning") or 0), cached_tokens=int(cached),
                )
            except Exception as exc:  # pragma: no cover - telemetry never breaks a turn
                print(f"[USAGE] Could not log model call: {type(exc).__name__}")


def _usage(response: LLMResult) -> dict[str, Any]:
    for generations in response.generations:
        for generation in generations:
            message = getattr(generation, "message", None)
            usage = getattr(message, "usage_metadata", None)
            if usage:
                return dict(usage)
    return dict((response.llm_output or {}).get("usage") or {})
