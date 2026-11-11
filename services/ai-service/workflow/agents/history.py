"""History subgraph: recall an earlier chat, then hand over what it found.

    START → search (LLM step + chat-search data steps) → delivery_gate ─┬─ asked for by id → deliver_files (action) → END
                                                                       ├─ "give me the file" → locate_file (data) ─┘
                                                                       └─ no file wanted ────────────────────────────────→ END

Finding a file and giving it to the user are different kinds of step, so they
are different nodes. ``search`` may only name a file; fetching its bytes is an
external action, performed once per turn, after the answer is written, and
audited by the backend as ``chat.file.attach``.

Asked for a file, GPT-OSS answers with its name and where it lives instead of
calling the delivery tool, and sometimes drops the name it gave a moment ago, so
the hand-over does not depend on it: ``delivery_gate`` recognises the request
deterministically and ``locate_file`` resolves the most recent filename in the
conversation against the user's own assets. A name that matches nothing of
theirs delivers nothing; repeat versions of one name deliver the current one.

The file never enters the model's context: the delivery is requested by asset
id, and ``deliver_files`` is what reads the content and attaches it.
"""
from __future__ import annotations

import json
import re
from typing import Annotated, Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Command

import guardrails
from utils.realtime_logger import ToolSpan
from workflow.agents.conversational import HistoryAgent
from workflow.agents.router import HAND_IT_OVER
from workflow.context import TurnContext
from workflow.state import latest
from workflow.tools.chat_search import MAX_REQUESTED_FILES


class HistoryState(TypedDict, total=False):
    # Shared with the turn graph.
    response: Annotated[str, latest]
    outputs: Annotated[dict[str, str], latest]
    # Private to this subgraph: what to hand over, asked for by the LLM step or resolved from its answer.
    requested_files: Annotated[list[dict[str, str]], latest]


FILENAME = re.compile(r"[\w][\w.\-]*\.(?:csv|xlsx?|sql|json|txt|md|ya?ml|parquet)", re.IGNORECASE)
# "share the mapping sheet filename" asks for a name, not for the file itself.
NAME_ONLY = re.compile(r"\bfile ?names?\b|\bname of\b|\bnamed\b|\bexact name\b|\bwhich file\b"
                       r"|\bwhat (?:was|is|were|are)\b.{0,30}\bcalled\b", re.IGNORECASE)


class SearchStep(HistoryAgent):
    """LLM step. The annotation is the node's input schema: inheriting the turn
    graph's would filter this subgraph's own keys out before the node runs."""

    async def __call__(self, state: HistoryState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
        return await super().__call__(state, runtime)


def fetched(raw: str) -> dict[str, Any]:
    """A gateway reply is screened JSON; anything else is an error, not content."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {"error": "the file could not be read"}
    if not isinstance(data, dict):
        return {"error": "the file could not be read"}
    return data


def compose(response: str, attached: list[str], problems: list[str], redacted: list[str] | None = None) -> str:
    """State the outcome of the action, because the model wrote its reply before it ran.

    The answer typically names the file and says where it lives ("attached to
    the mapping chat"), which is exactly what the user did not want to hear, so
    the hand-over is stated unless the reply already points at the download.
    """
    parts = [response.strip()] if response.strip() else []
    if attached and "download" not in response.lower():
        parts.append("Attached to this message: " + ", ".join(f"`{name}`" for name in attached)
                     + " — use the download button on the file card.")
    if redacted:
        parts.append("Some values in " + ", ".join(f"`{name}`" for name in redacted)
                     + " were redacted by the security filter, so the attached copy is not byte-for-byte the "
                     "original. The original is unchanged in My Files.")
    if problems:
        parts.append("I could not attach " + "; ".join(problems) + ". You can still open it from My Files.")
    return "\n\n".join(parts)


async def deliver_files(state: HistoryState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
    """Action step: fetch each requested file and attach it to this turn's reply."""
    context = runtime.context
    outputs: dict[str, str] = {}
    problems: list[str] = []
    redacted: list[str] = []
    for request in (state.get("requested_files") or [])[:MAX_REQUESTED_FILES]:
        label = request.get("filename") or request["id"]
        async with ToolSpan(context.logger, "attach_chat_file",
                            {"file_id": request["id"], "file_name": request.get("filename", "")}) as span:
            data = fetched(await context.gateway.chat_search("fetch", {"id": request["id"]}))
            if not isinstance(data.get("content"), str):
                reason = str(data.get("error") or "the file could not be read")
                problems.append(f"`{label}`: {reason.rstrip('.')}")
                span.result = f"Delivery of '{label}' failed: {reason}"
                continue
            name = data.get("filename") or label
            screened = guardrails.check_outbound(data["content"])
            content = screened.text
            if screened.decision == "redacted":
                redacted.append(name)
            outputs[name] = content
            span.result = f"File '{name}' attached (version {data.get('version', 1)}, {len(content)} characters)."
    return {"outputs": outputs, "response": compose(state.get("response", ""), list(outputs), problems, redacted)}


def delivery_gate(state: HistoryState, runtime: Runtime[TurnContext]) -> Command[Literal["locate_file", "deliver_files", "__end__"]]:
    """Was the user asking for the file itself, and did the answer hand it over?"""
    if state.get("requested_files"):
        return Command(goto="deliver_files")
    message = runtime.context.workspace.message
    if HAND_IT_OVER.search(message) and not NAME_ONLY.search(message):
        return Command(goto="locate_file")
    return Command(goto=END)


def named_file(state: HistoryState, context: TurnContext) -> str:
    """The file this request is about: named in the answer, or last named in the chat.

    A reply to "give me the file" often does not repeat the name it gave a
    moment ago ("here is the workbook from the Kestrel chat"), so the most
    recent filename in the conversation is what the user means by "the file".
    """
    for text in [state.get("response", ""), context.workspace.message,
                 *(message.get("content", "") for message in reversed(context.workspace.history[-8:]))]:
        found = FILENAME.findall(text or "")
        if found:
            return found[-1]
    return ""


async def locate_file(state: HistoryState, runtime: Runtime[TurnContext]) -> Command[Literal["deliver_files", "__end__"]]:
    """Data step: resolve that filename to one asset this user owns."""
    context = runtime.context
    name = named_file(state, context)
    if not name:
        return Command(goto=END)
    async with ToolSpan(context.logger, "search_chat_files", {"query": name, "scope": "all", "offset": 0}) as span:
        raw = await context.gateway.chat_search("files", {"query": name, "scope": "all", "offset": 0})
        span.result = raw
    matches = [file for file in (fetched(raw).get("files") or [])
               if file.get("filename", "").lower() == name.lower()]
    if not matches:
        # The answer named something that is not a file of theirs: its own reply
        # stands, and the user is not handed a file they did not ask for.
        return Command(goto=END)
    # Re-uploading a file is normal, so the same name has several versions;
    # "the file" is the current one.
    found = max(matches, key=lambda file: (file.get("version") or 0, file.get("createdAt") or ""))
    return Command(update={"requested_files": [{"id": str(found.get("assetId") or found.get("id") or ""),
                                                "filename": found.get("filename", name)}]},
                   goto="deliver_files")


def build_history_graph():
    builder = StateGraph(HistoryState, context_schema=TurnContext)
    builder.add_node("search", SearchStep())
    builder.add_node("delivery_gate", delivery_gate)
    builder.add_node("locate_file", locate_file)
    builder.add_node("deliver_files", deliver_files)
    builder.add_edge(START, "search")
    builder.add_edge("search", "delivery_gate")
    builder.add_edge("deliver_files", END)
    return builder.compile(name="history")
