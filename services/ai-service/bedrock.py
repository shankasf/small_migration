"""Bedrock GPT-OSS Chat Completions compatibility for the Agents SDK.

The runtime endpoint can include <reasoning> in content and does not reliably
enforce response_format. Use a final function call for typed agent results;
the SDK still validates its JSON against the application's Pydantic schema.
"""
import json
from openai.resources.chat.completions import AsyncCompletions

FINAL_TOOL = "emit_structured_response"


def clean_tool_name(name: str) -> str:
    """Strip Harmony control tokens the endpoint can leave glued to a tool name.

    GPT-OSS writes calls as `commentary to=functions.NAME <|constrain|>json`, and
    the runtime sometimes returns the trailing marker as part of the name — e.g.
    `read_impact_evidence<|channel|>commentary` — which the SDK then reports as an
    unknown tool. Keep only the name itself.
    """
    at = name.find("<|")
    if at >= 0:
        name = name[:at]
    name = name.strip()
    return name[len("functions."):] if name.startswith("functions.") else name


class AnswerFilter:
    """Remove reasoning even when either delimiter spans several SSE chunks."""
    def __init__(self):
        self.pending = ""
        self.reasoning = False

    def feed(self, text: str, final: bool = False) -> str:
        self.pending += text
        output = []
        while self.pending:
            marker = "</reasoning>" if self.reasoning else "<reasoning>"
            at = self.pending.find(marker)
            if at >= 0:
                if not self.reasoning:
                    output.append(self.pending[:at])
                self.pending = self.pending[at + len(marker):]
                self.reasoning = not self.reasoning
                continue
            keep = 0
            if not final:
                for length in range(1, min(len(marker), len(self.pending) + 1)):
                    if self.pending.endswith(marker[:length]):
                        keep = length
            safe = self.pending[:-keep] if keep else self.pending
            if not self.reasoning:
                output.append(safe)
            self.pending = self.pending[-keep:] if keep else ""
            break
        return "".join(output)


class BedrockCompletions(AsyncCompletions):
    async def create(self, *args, **kwargs):
        if kwargs.get("stream"):
            kwargs["stream_options"] = {"include_usage": True}
        response_format = kwargs.get("response_format")
        structured = isinstance(response_format, dict) and response_format.get("type") == "json_schema"
        if structured:
            if kwargs.get("stream"):
                raise ValueError("Bedrock typed results must use non-streaming Runner.run")
            schema = kwargs.pop("response_format")["json_schema"]
            tools = list(kwargs["tools"]) if isinstance(kwargs.get("tools"), list) else []
            tools.append({"type": "function", "function": {
                "name": FINAL_TOOL, "description": "Return the final answer in the required format.",
                "parameters": schema["schema"], "strict": True,
            }})
            kwargs["tools"] = tools
            kwargs["parallel_tool_calls"] = False
            kwargs["tool_choice"] = ({"type": "function", "function": {"name": FINAL_TOOL}}
                                     if len(tools) == 1 else "auto")
            kwargs["messages"] = [
                {"role": "system", "content": "Use the available tools to gather any needed evidence. "
                 "When ready to answer, call emit_structured_response with your final result. "
                 "Never return the final answer as plain text."},
                *kwargs["messages"],
            ]
        response = await super().create(*args, **kwargs)
        if kwargs.get("stream"):
            return self._answer_stream(response)
        for choice in response.choices:
            message = choice.message
            if message.content:
                message.content = AnswerFilter().feed(message.content, final=True)
            for call in message.tool_calls or []:
                call.function.name = clean_tool_name(call.function.name)
            if structured:
                final_calls = [call for call in message.tool_calls or [] if call.function.name == FINAL_TOOL]
                if final_calls:
                    if len(message.tool_calls) != 1:
                        raise ValueError("Bedrock returned final output alongside unfinished tool calls")
                    # Do not repair or invent fields; the agent's schema validates this.
                    json.loads(final_calls[0].function.arguments)
                    message.content = final_calls[0].function.arguments
                    message.tool_calls = None
                    choice.finish_reason = "stop"
        return response

    @staticmethod
    async def _answer_stream(stream):
        filters = {}
        try:
            async for chunk in stream:
                for choice in chunk.choices:
                    filter_ = filters.setdefault(choice.index, AnswerFilter())
                    content = filter_.feed(choice.delta.content or "", final=choice.finish_reason is not None)
                    choice.delta.content = content or None
                    for call in choice.delta.tool_calls or []:
                        if call.function and call.function.name:
                            call.function.name = clean_tool_name(call.function.name)
                yield chunk
        finally:
            await stream.close()
