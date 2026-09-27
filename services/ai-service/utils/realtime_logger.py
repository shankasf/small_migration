"""
Real-time activity logger.

Every observable step of an agent turn — guardrail decisions, each model call
with its own token counts, every tool call and its result, the final output —
is posted to the backend, which attributes it to the acting user, prices the
tokens and persists it. The backend owns identity and cost; this module owns
*what* is worth recording and how much of a payload is safe to record.

Payload previews are truncated first and then passed through the outbound
guardrail filter, so a tool argument carrying health PII is never written to
the activity log verbatim.
"""

import json
import time
from typing import Optional, Any, Dict

import httpx

import guardrails
from config import settings

# Upper bound on any single payload preview written to the activity log.
PREVIEW_MAX_CHARS = 4000
# The final assistant output is the record of what the user actually received,
# so it gets a larger allowance than an intermediate tool payload.
OUTPUT_MAX_CHARS = 20000


def preview(value: Any, limit: int = PREVIEW_MAX_CHARS) -> str:
    """Truncate, then guardrail-filter, a value for safe logging."""
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    text = guardrails.check_outbound(text).text
    truncated = len(text) > limit
    if truncated:
        text = f"{text[:limit]}\n… [truncated, {len(text)} characters total]"
    try:
        return guardrails.check_outbound(text).text
    except Exception:
        # A filter failure must never cost us the log line; drop the payload
        # rather than risk emitting unfiltered content.
        return "[preview unavailable — guardrail filter error]"


class RealtimeLogger:
    """Sends structured activity events to the backend."""

    def __init__(
        self,
        session_id: str,
        turn_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ):
        self.session_id = session_id
        self.turn_id = turn_id
        self.user_id = user_id
        self.backend_url = f"{settings.BACKEND_URL}/api/logs/{session_id}"
        headers = {}
        if settings.INTERNAL_API_KEY:
            headers["x-internal-key"] = settings.INTERNAL_API_KEY
        self._client = httpx.AsyncClient(timeout=5.0, headers=headers)

    async def log(
        self,
        step: str,
        message: str,
        log_type: str = "info",
        data: Optional[Any] = None,
        *,
        tool: Optional[str] = None,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        duration_ms: Optional[int] = None,
        detail: Optional[Any] = None,
    ):
        """Send one activity event to the backend."""
        try:
            payload: Dict[str, Any] = {
                "step": step,
                "message": message,
                "type": log_type,
                "turn_id": self.turn_id,
                "user_id": self.user_id,
            }
            if data is not None:
                payload["data"] = data
            if detail is not None:
                payload["detail"] = detail
            if tool is not None:
                payload["tool"] = tool
            if model is not None:
                payload["model"] = model
            if provider is not None:
                payload["provider"] = provider
            if input_tokens is not None:
                payload["input_tokens"] = int(input_tokens)
            if output_tokens is not None:
                payload["output_tokens"] = int(output_tokens)
            if duration_ms is not None:
                payload["duration_ms"] = int(duration_ms)

            await self._client.post(self.backend_url, json=payload)
        except Exception as e:
            # Don't let logging failures break the main flow
            print(f"[RealtimeLogger] Failed to send log: {e}")

    # ---------------- Agent observability -------------------------------

    async def tool_call(self, name: str, args: Dict[str, Any]):
        """An agent tool was invoked, with its (previewed) arguments."""
        arg_summary = ", ".join(f"{k}={v}" for k, v in _summarise_args(args).items())
        await self.log(
            step="tool.call",
            message=f"Tool call → {name}({arg_summary})",
            log_type="tool",
            tool=name,
            detail={"tool": name, "arguments": {k: preview(v) for k, v in args.items()}},
        )

    async def tool_result(
        self,
        name: str,
        result: Any,
        duration_ms: int,
        ok: bool = True,
    ):
        """A tool returned (or raised), with its previewed result."""
        text = preview(result)
        head = text.splitlines()[0] if text else ""
        await self.log(
            step="tool.result",
            message=f"Tool {'result' if ok else 'error'} ← {name} ({duration_ms} ms): {head}",
            log_type="success" if ok else "error",
            tool=name,
            duration_ms=duration_ms,
            detail={"tool": name, "ok": ok, "result": text},
        )

    async def llm_call(
        self,
        model: str,
        provider: str,
        input_tokens: int,
        output_tokens: int,
        duration_ms: Optional[int] = None,
        reasoning_tokens: int = 0,
        cached_tokens: int = 0,
        stop_reason: str = "",
    ):
        """One model call completed — the unit tokens and cost are billed on."""
        await self.log(
            step="llm.call",
            message=(
                f"Model call {model} — {input_tokens:,} in / {output_tokens:,} out"
                + (f", {reasoning_tokens:,} reasoning" if reasoning_tokens else "")
                + (f", stopped: {stop_reason}" if stop_reason else "")
            ),
            log_type="usage",
            model=model,
            provider=provider,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            duration_ms=duration_ms,
            detail={
                "model": model,
                "provider": provider,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "reasoningTokens": reasoning_tokens,
                "cachedTokens": cached_tokens,
                "stopReason": stop_reason,
            },
        )

    async def agent_output(self, text: str, duration_ms: Optional[int] = None):
        """The assistant's final answer for this turn."""
        body = preview(text, OUTPUT_MAX_CHARS)
        await self.log(
            step="agent.output",
            message=f"Final output — {len(text or '')} characters",
            log_type="success",
            duration_ms=duration_ms,
            detail={"output": body, "chars": len(text or "")},
        )

    async def guardrail(self, stage: str, decision: str, reasons, findings):
        """Inbound/outbound guardrail verdict."""
        await self.log(
            step="guardrail",
            message=f"Guardrail {stage}: {decision}"
                    + (f" — {', '.join(reasons)}" if reasons else ""),
            log_type="error" if decision == "blocked" else "info" if decision == "allow" else "success",
            detail={"stage": stage, "decision": decision, "reasons": list(reasons or []), "findings": findings},
        )

    # ---------------- Progress messages (transient UI feedback) ---------

    async def file_detected(self, filename: str, detected_type: str, confidence: str):
        """Log file detection"""
        await self.log(
            step="file_detection",
            message=f"Detected '{filename}' as {detected_type}",
            log_type="success" if confidence == "high" else "info",
            data={"filename": filename, "type": detected_type, "confidence": confidence}
        )

    async def analyzing_file(self, filename: str):
        """Log file analysis start"""
        await self.log(
            step="file_analysis",
            message=f"Analyzing {filename}...",
            log_type="progress"
        )

    async def parsing_content(self, content_type: str):
        """Log content parsing"""
        await self.log(
            step="parsing",
            message=f"Parsing {content_type} content...",
            log_type="progress"
        )

    async def ai_thinking(self, message: str = "Processing with AI..."):
        """Log AI processing"""
        await self.log(
            step="ai_processing",
            message=message,
            log_type="progress"
        )

    async def thinking(self, message: str):
        """Send a thinking status that replaces previous thinking messages"""
        await self.log(
            step="thinking",
            message=message,
            log_type="thinking"  # Special type for disappearing status
        )

    async def generating_output(self, filename: str):
        """Log output generation"""
        await self.log(
            step="generation",
            message=f"Generating {filename}...",
            log_type="progress"
        )

    async def complete(self, message: str = "Processing complete"):
        """Log completion"""
        await self.log(
            step="complete",
            message=message,
            log_type="success"
        )

    async def error(self, message: str):
        """Log error"""
        await self.log(
            step="error",
            message=message,
            log_type="error"
        )

    async def close(self):
        """Close the HTTP client"""
        await self._client.aclose()


def _summarise_args(args: Dict[str, Any]) -> Dict[str, str]:
    """Compact one-line argument summary for the log message itself."""
    summary: Dict[str, str] = {}
    for key, value in args.items():
        if isinstance(value, str) and len(value) > 60:
            summary[key] = f"<{len(value)} chars>"
        else:
            summary[key] = str(value)
    return summary


class ToolSpan:
    """Async context manager that logs a tool call, its result and duration.

    Usage:
        async with ToolSpan(logger, "generate_output", {...}) as span:
            span.result = do_work()
            return span.result
    """

    def __init__(self, logger: Optional[RealtimeLogger], name: str, args: Dict[str, Any]):
        self.logger = logger
        self.name = name
        self.args = args
        self.result: Any = None
        self._started = 0.0

    async def __aenter__(self) -> "ToolSpan":
        self._started = time.monotonic()
        if self.logger:
            await self.logger.tool_call(self.name, self.args)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        elapsed_ms = int((time.monotonic() - self._started) * 1000)
        if self.logger:
            if exc is not None:
                await self.logger.tool_result(self.name, f"{exc_type.__name__}: {exc}", elapsed_ms, ok=False)
            else:
                await self.logger.tool_result(self.name, self.result, elapsed_ms, ok=True)
        return False
