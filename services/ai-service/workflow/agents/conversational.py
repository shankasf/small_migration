"""Specialists that answer the user directly: History, Repository, Consultant.

Each is an LLM step looping over its own data-step tools (``ToolLoopAgent``).
They share one template — system prompt, then the conversation, then the
current message — and differ only in their prompt, tools and briefing notes.
"""
from __future__ import annotations

from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langgraph.runtime import Runtime

from workflow.agents.base import ToolLoopAgent, ToolLoopSpec
from workflow.agents.formatting import history_messages
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.state import TurnState
from workflow.tools.chat_search import CHAT_SEARCH_TOOLS
from workflow.tools.files import FILE_TOOLS
from workflow.tools.github import GITHUB_TOOLS

NO_ANSWER = ("I couldn't complete that request just now. Please try again, or rephrase what you need "
             "from your migration files.")


class ConversationalSpecialist(ToolLoopAgent):
    prompts: tuple[str, ...] = ()
    progress = "Working on it..."

    def system_prompt(self) -> str:
        return prompt(*self.prompts)

    def notes(self, context: TurnContext) -> list[str]:
        """Extra, turn-specific context for the system message."""
        return []

    def brief(self, context: TurnContext) -> list[BaseMessage]:
        system = "\n\n".join([self.system_prompt(), *self.notes(context)])
        return [SystemMessage(system), *history_messages(context.workspace.history),
                HumanMessage(context.workspace.message)]

    async def __call__(self, state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
        context = runtime.context
        if context.logger:
            await context.logger.thinking(self.progress)
        outcome = await self.run(self.brief(context), context)
        return {"response": outcome.text or NO_ANSWER}


class HistoryAgent(ConversationalSpecialist):
    prompts = ("history",)
    progress = "Searching your saved chats..."

    def __init__(self) -> None:
        super().__init__(ToolLoopSpec(name="history", role=ModelRole.HISTORY, tools=CHAT_SEARCH_TOOLS,
                                      first_tool="search_chat_history", max_rounds=6))


class RepositoryAgent(ConversationalSpecialist):
    prompts = ("repository",)
    progress = "Reading your repository..."

    def __init__(self) -> None:
        super().__init__(ToolLoopSpec(name="repository", role=ModelRole.REPOSITORY, tools=GITHUB_TOOLS,
                                      max_rounds=10))

    def notes(self, context: TurnContext) -> list[str]:
        if not context.workspace.github_hint:
            return []
        return ["Current authenticated actor's GitHub connection metadata (not proof of live repository "
                f"access): {context.workspace.github_hint}. Verify with GitHub tools before claiming access. "
                "Saved branch is the default for this turn."]


class ConsultantAgent(ConversationalSpecialist):
    prompts = ("consultant", "migration_scope", "dbt_rules")
    progress = "Thinking through your migration question..."

    def __init__(self) -> None:
        super().__init__(ToolLoopSpec(name="consult", role=ModelRole.CONSULTANT, tools=FILE_TOOLS, max_rounds=6))

    def notes(self, context: TurnContext) -> list[str]:
        files = list(context.workspace.files)
        return [f"Files attached to this turn: {', '.join(files)}." if files else "No files are attached."]
