"""Specialists that answer the user directly: History, Repository, Consultant.

Each is an LLM step looping over its own data-step tools (``ToolLoopAgent``).
They share one template — system prompt, then the conversation, then the
current message with this chat's attached files — and differ only in their
prompt, tools and briefing notes.

Attached files are put in front of every specialist deterministically. A model
that had to call a tool to read them sometimes never did, then told the user it
could not see a file it had just used; with the text in the message it cannot
be unaware of it. Files are untrusted data, so they go in the user message,
never in the system message.
"""
from __future__ import annotations

from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langgraph.runtime import Runtime

import guardrails
from workflow.agents.base import ToolLoopAgent, ToolLoopSpec
from workflow.agents.formatting import files_block, history_messages, memory_notes
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.state import TurnState
from workflow.tools.chat_search import CHAT_SEARCH_TOOLS
from workflow.tools.files import FILE_TOOLS
from workflow.tools.github import GITHUB_TOOLS
from workflow.tools.memory import MEMORY_TOOLS

NO_ANSWER = ("I couldn't complete that request just now. Please try again, or rephrase what you need "
             "from your migration files.")
# Attached text shown to a conversational specialist. Bounded so a chat with
# many large uploads still fits the context window with history and tools.
CONVERSATIONAL_FILES_BUDGET_CHARS = 150_000


class ConversationalSpecialist(ToolLoopAgent):
    prompts: tuple[str, ...] = ()
    progress = "Working on it..."
    files_budget = CONVERSATIONAL_FILES_BUDGET_CHARS

    def system_prompt(self) -> str:
        return prompt(*self.prompts)

    def notes(self, context: TurnContext, state: TurnState) -> list[str]:
        """Extra, turn-specific context for the system message."""
        return []

    def can_read_files(self) -> bool:
        return any(tool.name == "get_file_content" for tool in self.spec.tools)

    def attachments(self, context: TurnContext) -> str:
        """This chat's attached files as untrusted data, with a load report."""
        files = context.workspace.files
        if not files:
            return ""
        # The same outbound screen a get_file_content read gets.
        screened = {name: guardrails.check_outbound(content).text for name, content in files.items()}
        hint = ("Call get_file_content with the exact label and an offset to read the rest before answering "
                "about it." if self.can_read_files() else
                "You cannot read the rest in this step: tell the user which file was only partly loaded and up "
                "to which point you read it, and do not guess at the missing part.")
        return files_block(screened, self.files_budget, more_hint=hint)

    def brief(self, context: TurnContext, state: TurnState) -> list[BaseMessage]:
        system = "\n\n".join([self.system_prompt(), *memory_notes(context), *self.notes(context, state)])
        message = context.workspace.message
        attached = self.attachments(context)
        current = f"## Current request\n{message}\n\n## Files attached to this chat\n{attached}" if attached else message
        return [SystemMessage(system), *history_messages(context.workspace.history), HumanMessage(current)]

    async def __call__(self, state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
        context = runtime.context
        if context.logger:
            await context.logger.thinking(self.progress)
        outcome = await self.run(self.brief(context, state), context)
        return {"response": outcome.text or NO_ANSWER}


class HistoryAgent(ConversationalSpecialist):
    """LLM step of the history pipeline; ``agents/history.py`` delivers what it asks for."""

    prompts = ("history",)
    progress = "Searching your saved chats..."

    def __init__(self) -> None:
        super().__init__(ToolLoopSpec(name="history", role=ModelRole.HISTORY, tools=CHAT_SEARCH_TOOLS,
                                      first_tool="search_chat_history", max_rounds=6))

    def notes(self, context: TurnContext, state: TurnState) -> list[str]:
        if not context.workspace.files:
            return []
        return ["Files are attached to this chat and their text is in the user's message under 'Files attached "
                "to this chat'. For questions about what one of those files says, answer from that text: a "
                "search excerpt is only a fragment and never shows that a file's content is unavailable."]

    async def __call__(self, state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
        answer = await super().__call__(state, runtime)
        # Deliveries the tool queued this turn become state the next node acts on.
        return {**answer, "requested_files": list(runtime.context.workspace.file_requests)}


class RepositoryAgent(ConversationalSpecialist):
    prompts = ("repository",)
    progress = "Reading your repository..."

    def __init__(self) -> None:
        super().__init__(ToolLoopSpec(name="repository", role=ModelRole.REPOSITORY, tools=GITHUB_TOOLS,
                                      max_rounds=10))

    def notes(self, context: TurnContext, state: TurnState) -> list[str]:
        if not context.workspace.github_hint:
            return []
        return ["Current authenticated actor's GitHub connection metadata (not proof of live repository "
                f"access): {context.workspace.github_hint}. Verify with GitHub tools before claiming access. "
                "Saved branch is the default for this turn."]


class ConsultantAgent(ConversationalSpecialist):
    prompts = ("consultant", "migration_scope", "dbt_rules")
    progress = "Thinking through your migration question..."

    def __init__(self) -> None:
        super().__init__(ToolLoopSpec(name="consult", role=ModelRole.CONSULTANT,
                                      tools=[*FILE_TOOLS, *MEMORY_TOOLS], max_rounds=6))

    def notes(self, context: TurnContext, state: TurnState) -> list[str]:
        files = list(context.workspace.files)
        if not files:
            return ["No files are attached to this chat."]
        return [f"Files attached to this chat: {', '.join(files)}. Their text is already in the user's message "
                "under 'Files attached to this chat'; read it there. Use get_file_content only for a part the "
                "load report says was not shown."]
