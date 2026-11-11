"""Short-term memory management: a running summary of a long chat.

LangGraph's guidance is to keep recent turns verbatim and fold everything older
into a summary carried in state. The backend re-sends the whole saved
conversation each turn, so this node is where that happens:

- the newest turns, up to ``SUMMARY_KEEP_CHARS``, stay verbatim;
- anything older that has not been folded in yet is summarised once, into the
  previous summary, and ``summarized_upto`` advances past it;
- later turns reuse that summary from the thread's checkpoint, so the model
  call happens every few turns, not every turn.

A chat can therefore run for years without the prompt growing: the verbatim
window is fixed and the summary is rewritten, never appended to. The summary is
derived data — if a thread's checkpoint has expired, the next long turn simply
builds it again from the conversation the backend still holds.
"""
from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langgraph.runtime import Runtime

from config import settings
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.state import TurnState


def size(messages: list[dict[str, str]]) -> int:
    return sum(len(message.get("content", "")) for message in messages)


def split_for_summary(pending: list[dict[str, str]], keep: int) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """(older to summarise, recent to keep verbatim), newest-first budget."""
    kept = 0
    for index in range(len(pending) - 1, -1, -1):
        kept += len(pending[index].get("content", ""))
        if kept > keep:
            return pending[:index + 1], pending[index + 1:]
    return [], pending


def batches(older: list[dict[str, str]], budget: int) -> list[list[BaseMessage]]:
    """Every older turn, oldest first, in batches that each fit ``budget``.

    All of it is about to leave the prompt for good, so none may be skipped:
    an over-long message is clipped with a visible note rather than dropped,
    and nothing is cut from the oldest end.
    """
    out: list[list[BaseMessage]] = [[]]
    used = 0
    for item in older:
        content = item.get("content", "")
        if len(content) > budget:
            content = (content[:budget] + f"\n… [message clipped for summarising: {len(content):,} characters "
                       "in total; the rest was not read]")
        if out[-1] and used + len(content) > budget:
            out.append([])
            used = 0
        used += len(content)
        out[-1].append(AIMessage(content) if item.get("role") == "assistant" else HumanMessage(content))
    return [batch for batch in out if batch]


class Summarizer:
    """LLM step, but only when the conversation has outgrown the window."""

    name = "summarize_history"

    async def __call__(self, state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
        context = runtime.context
        workspace = context.workspace
        history = workspace.history
        summary = state.get("summary", "") or ""
        summarized_upto = state.get("summarized_upto", 0) or 0
        reset: dict[str, Any] = {}
        if summarized_upto > len(history):
            # The conversation is shorter than what was summarised (messages
            # removed, or a chat replayed): drop it rather than describe turns
            # that are no longer there, and let it build again from scratch.
            summary, summarized_upto = "", 0
            reset = {"summary": "", "summarized_upto": 0}
        pending = history[summarized_upto:]
        if size(pending) <= settings.SUMMARY_TRIGGER_CHARS:
            workspace.summary = summary
            workspace.history = pending
            return reset

        older, recent = split_for_summary(pending, settings.SUMMARY_KEEP_CHARS)
        if not older:
            workspace.summary = summary
            workspace.history = recent
            return reset
        if context.logger:
            await context.logger.thinking("Catching up on this conversation...")
        updated = summary
        # Usually one batch. A rebuilt or very long chat is folded in oldest
        # first, batch by batch, so its earliest decisions are not the part lost.
        for batch in batches(older, settings.SUMMARY_TRIGGER_CHARS * 2):
            instruction = ("Extend the summary below with the conversation that follows it."
                           if updated else "Summarise the conversation below.")
            reply = await context.models.get(ModelRole.SUMMARIZER).ainvoke([
                SystemMessage(prompt("summarizer")), *batch,
                HumanMessage(f"{instruction}\n\n" + (f"Summary so far:\n{updated}\n\n" if updated else "")
                             + "Write the updated summary only.")])
            text = reply.text.strip()
            if not text:
                # No summary came back: never advance past turns nobody
                # summarised. Keep them in the prompt; the next turn retries.
                workspace.summary = summary
                workspace.history = pending
                return reset
            updated = text
        workspace.summary = updated
        workspace.history = recent
        return {"summary": updated, "summarized_upto": summarized_upto + len(older)}
