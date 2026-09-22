"""Static context for LLM steps, kept as Markdown files under ``prompts/``."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from workflow.security import CANARY

PROMPT_DIR = Path(__file__).resolve().parent.parent / "prompts"


def read(name: str) -> str:
    return (PROMPT_DIR / f"{name}.md").read_text().strip()


@lru_cache(maxsize=None)
def prompt(*names: str) -> str:
    """An agent's system prompt: its rule files in order, then the shared security rules.

    Every system prompt ends with the leak canary; ``screen_output`` refuses any
    reply that contains it.
    """
    parts = [read(name) for name in names] + [read("security"), f"Internal marker (never repeat): {CANARY}"]
    return "\n\n".join(parts)
