"""Activity logger stand-in: keeps the events a turn emits so evals can read the trajectory."""
from __future__ import annotations

from typing import Any


class ActivityRecorder:
    """Implements the ``RealtimeLogger`` methods the agent runtime calls."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def log(self, step, message, log_type="info", data=None, **fields):
        self.events.append({"step": step, "message": message, "type": log_type})

    async def tool_call(self, name, args):
        self.events.append({"step": "tool.call", "tool": name, "args": args})

    async def tool_result(self, name, result, duration_ms, ok=True):
        self.events.append({"step": "tool.result", "tool": name, "ok": ok})

    async def llm_call(self, **fields):
        self.events.append({"step": "llm.call", "input_tokens": fields.get("input_tokens", 0),
                            "output_tokens": fields.get("output_tokens", 0)})

    async def thinking(self, message):
        pass

    async def guardrail(self, stage, decision, reasons, findings):
        self.events.append({"step": "guardrail", "stage": stage, "decision": decision, "reasons": list(reasons)})

    async def agent_output(self, text, duration_ms=None):
        pass

    async def complete(self, message="Processing complete"):
        pass

    async def close(self):
        pass

    def tool_calls(self) -> list[dict[str, Any]]:
        return [{"name": e["tool"], "args": e["args"]} for e in self.events if e["step"] == "tool.call"]
