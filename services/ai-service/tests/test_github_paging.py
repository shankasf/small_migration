"""read_github_file pages long files instead of losing everything past the tool-result cap.
Synthetic data only."""
import asyncio
import json

import httpx
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from fakes import FakeRegistry, turn_context
from workflow.context import TurnContext
from workflow.gateway import HttpBackendGateway
from workflow.security import TOOL_RESULT_MAX_CHARS, guard_tool_call
from workflow.tools.github import GITHUB_TOOLS, page_header

SHA = "c" * 40
BUDGET = 50_000


def backend_page(content: str, offset: int) -> dict:
    """Mirror of the backend's githubFilePage: line-boundary pages whose numbered,
    JSON-escaped size stays within the 50k budget."""
    start_line = content[:offset].count("\n") + 1

    def cost(end: int) -> int:
        page = content[offset:end]
        lines = page.count("\n") + 1
        return len(json.dumps(page, ensure_ascii=False)) - 2 + lines * (3 + len(str(start_line + lines)))
    end = min(len(content), offset + BUDGET)
    while True:
        if end < len(content):
            newline = content.rfind("\n", offset, end)
            if newline >= offset:
                end = newline + 1
        size = cost(end)
        if size <= BUDGET or end - offset <= 1:
            break
        end = offset + max(1, (end - offset) * BUDGET // size - 1)
    following = end if end < len(content) else None
    return {"repository": "demo/dbt", "path": "models/big.sql", "commitSha": SHA, "content": content[offset:end],
            "offset": offset, "startLine": start_line, "totalCharacters": len(content), "nextOffset": following,
            "hasMore": following is not None, "partial": offset > 0 or following is not None}


def harness(content: str):
    requests = []

    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(200, json=backend_page(content, body["args"].get("offset", 0)))
    gateway = HttpBackendGateway("session-fixed", "actor-current", base_url="http://backend.test",
                                 internal_key="internal-test-value", transport=httpx.MockTransport(handler))
    builder = StateGraph(MessagesState, context_schema=TurnContext)
    builder.add_node("tools", ToolNode(GITHUB_TOOLS, awrap_tool_call=guard_tool_call))
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    graph = builder.compile()
    context = turn_context(FakeRegistry(), gateway)

    def read(**args):
        call = AIMessage("", tool_calls=[{"name": "read_github_file", "args": {"path": "models/big.sql", **args},
                                          "id": "call-1", "type": "tool_call"}])
        result = asyncio.run(graph.ainvoke({"messages": [HumanMessage("x"), call]}, context=context))
        return result["messages"][-1].content
    return read, requests


# Worst case for the cap: many short lines full of characters JSON must escape.
BIG = "\n".join(f'select "c{i}"\t, \'x\' as v{i}' for i in range(9000))


def test_a_long_file_reads_completely_page_by_page_without_clipping():
    read, requests = harness(BIG)
    offset, seen, pages = 0, [], 0
    while offset is not None:
        content = read(**({"offset": offset} if offset else {}))
        pages += 1
        assert len(content) <= TOOL_RESULT_MAX_CHARS and "[truncated" not in content
        data = json.loads(content)
        assert data["page"].startswith(f"characters {offset:,}–")  # header names what this page covers
        assert list(data)[0] == "page" and list(data)[-1] == "content"
        if data["nextOffset"] is not None:
            assert f"offset={data['nextOffset']}" in data["page"] and SHA in data["page"]
        else:
            assert "last page" in data["page"]
        assert data["content"].startswith(f"L{data['startLine']}| ")
        numbered = data["content"].splitlines()
        # Labels run on from the previous page with no duplicate for the line boundary.
        assert [int(line.split("| ", 1)[0][1:]) for line in numbered] == list(
            range(data["startLine"], data["startLine"] + len(numbered)))
        seen.extend(line.split("| ", 1)[1] for line in numbered)
        offset = data["nextOffset"]
    assert pages > 1 and seen == BIG.split("\n")
    # First page sends no offset (existing callers unchanged); later pages send it.
    assert "offset" not in requests[0]["args"] and all("offset" in r["args"] for r in requests[1:])


def test_a_small_file_is_returned_whole_without_a_page_header():
    read, requests = harness("select 1\nfrom t")
    data = json.loads(read())
    assert "page" not in data and data["content"] == "L1| select 1\nL2| from t"
    assert requests[0]["args"] == {"path": "models/big.sql", "repository_id": 0, "installation_id": 0, "ref": ""}


def test_page_header_leaves_non_file_and_error_results_untouched():
    for untouched in ("not json", json.dumps({"error": "x", "status": 400}), json.dumps({"entries": []}),
                      json.dumps({"content": "x", "partial": False, "totalCharacters": 1})):
        assert page_header(untouched) == untouched


def test_read_github_file_schema_offers_offset():
    tool = next(t for t in GITHUB_TOOLS if t.name == "read_github_file")
    assert "offset" in tool.tool_call_schema.model_fields
    assert "no offset" not in tool.description
