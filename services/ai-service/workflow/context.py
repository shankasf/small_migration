"""Per-turn runtime context, injected into every node and tool.

LangGraph passes this object to nodes as ``runtime.context`` and to tools as
``runtime.context`` via ``ToolRuntime``. It is supplied fresh on every invoke or
resume and is never written to a checkpoint, which is why raw request content,
uploaded files and service handles live here rather than in graph state.
"""
from dataclasses import dataclass, field
from typing import Any, Optional

# Real imports, not TYPE_CHECKING ones: LangChain builds a pydantic schema for
# tools that receive this context, and forward references would not resolve.
from utils.realtime_logger import RealtimeLogger
from workflow.gateway import BackendGateway
from workflow.models import ModelRegistry


@dataclass(frozen=True)
class TurnRequest:
    """The backend's request exactly as received — unscreened, never persisted."""

    message: str
    files: dict[str, str] = field(default_factory=dict)
    history: list[dict[str, str]] = field(default_factory=list)
    github_context: Optional[dict[str, Any]] = None
    impact_context: dict[str, Any] = field(default_factory=dict)


@dataclass
class TurnWorkspace:
    """Screened working data for one turn, written once by the intake node.

    File contents and history can be hundreds of kilobytes, so they stay in
    memory for the run instead of being copied into every checkpoint.
    """

    message: str = ""
    files: dict[str, str] = field(default_factory=dict)
    history: list[dict[str, str]] = field(default_factory=list)
    impact_history: list[dict[str, str]] = field(default_factory=list)
    github_hint: str = ""


@dataclass
class TurnContext:
    session_id: str
    actor_id: Optional[str]
    turn_id: Optional[str]
    request: TurnRequest
    gateway: BackendGateway
    models: ModelRegistry
    logger: Optional[RealtimeLogger] = None
    workspace: TurnWorkspace = field(default_factory=TurnWorkspace)

    @property
    def impact(self) -> dict[str, Any]:
        """Backend-owned impact-analysis grant for this turn (authoritative)."""
        return self.request.impact_context or {}

    @property
    def impact_state(self) -> dict[str, Any]:
        return self.impact.get("state") or {}
