"""Typed LLM steps.

GPT-OSS on Bedrock Converse does not support ``tool_choice`` and does not honour
JSON-schema output, so structured output uses unforced function calling. A reply
that does not parse is an LLM-recoverable error: the parse error goes back to the
model and it tries again, the loop-back pattern LangGraph's error-handling
guidance gives for that class of failure.
"""
from __future__ import annotations

from typing import TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage
from pydantic import BaseModel

Schema = TypeVar("Schema", bound=BaseModel)


class StructuredOutputError(RuntimeError):
    """The model never produced a valid result; the turn fails loudly."""


async def invoke_structured(model: BaseChatModel, schema: type[Schema], messages: list[BaseMessage],
                            *, attempts: int = 3) -> Schema:
    runnable = model.with_structured_output(schema, method="function_calling", include_raw=True)
    conversation = list(messages)
    for _ in range(attempts):
        result = await runnable.ainvoke(conversation)
        parsed = result.get("parsed")
        if parsed is not None:
            return parsed
        problem = result.get("parsing_error") or "no function call was returned"
        conversation = [*messages, HumanMessage(
            f"Your previous reply was not a valid call to the `{schema.__name__}` function ({problem}). "
            f"Call `{schema.__name__}` exactly once with the complete result and nothing else.")]
    raise StructuredOutputError(f"{schema.__name__} was not produced after {attempts} attempts")
