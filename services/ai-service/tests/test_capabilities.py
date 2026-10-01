import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from langgraph.store.memory import InMemoryStore

from fakes import FakeRegistry, turn_context
from routes.capabilities import ToolRequest, execute, execute_tool, validate_arguments
from workflow.catalog import TOOLS, TOOL_AGENTS, agents_catalog, tools_catalog
from workflow.memory import user_namespace


def run(coro):
    return asyncio.run(coro)


def test_catalog_contains_every_agent_tool_with_public_schemas():
    catalog = tools_catalog()
    assert len(catalog) == 12
    assert len(agents_catalog()) == 15
    assert {t["name"] for t in catalog} == {t.name for a in TOOL_AGENTS.values() for t in a.spec.tools}
    for tool in catalog:
        assert tool["agents"]
        assert tool["inputSchema"]["additionalProperties"] is False
        assert not {"runtime", "user_id", "session_id", "actor_id", "impact_state"} & set(tool["inputSchema"]["properties"])


@pytest.mark.parametrize("name,args", [
    ("missing_tool", {}), ("list_files", {"runtime": {"actor_id": "other"}}),
    ("search_chat_history", {"query": 22}),
    ("search_chat_history", {"query": "mapping", "scope": "everyone"}),
    ("read_github_file", {}), ("list_github_files", {"repository_id": "12"}),
])
def test_invalid_arguments_reject_before_execution(name, args):
    with pytest.raises(HTTPException) as error:
        validate_arguments(name, args)
    assert error.value.status_code in {400, 404}


def test_direct_execution_uses_real_tools_without_calling_a_model():
    context = turn_context(FakeRegistry())
    context.workspace.files = {"model.sql": "select 731 as value"}
    assert "model.sql" in run(execute_tool("list_files", {}, context))["result"]
    assert run(execute_tool("get_file_content", {"file_name": "model.sql"}, context)) == {
        "ok": True, "result": "select 731 as value"}


def test_memory_is_scoped_to_authenticated_actor_and_forget_works():
    store = InMemoryStore()
    alice = turn_context(FakeRegistry(), actor_id="alice")
    assert run(execute_tool("remember", {"subject": "target schema", "fact": "Use STAGING_TEST"}, alice, store))["ok"]
    assert len(run(store.asearch(user_namespace("alice")))) == 1
    assert not run(store.asearch(user_namespace("bob")))
    assert run(execute_tool("forget", {"subject": "target schema"}, alice, store))["ok"]
    assert not run(store.asearch(user_namespace("alice")))


def test_outbound_tool_content_is_redacted():
    context = turn_context(FakeRegistry())
    context.workspace.files = {"model.sql": "-- contact someone@example.com\nselect 1"}
    result = run(execute_tool("get_file_content", {"file_name": "model.sql"}, context))
    assert "someone@example.com" not in result["result"]


@pytest.mark.parametrize("name,args,expected", [
    ("remember", {"subject": "schema", "fact": "STAGING_TEST"}, 400),
    ("forget", {"subject": "schema"}, 400),
    ("read_impact_evidence", {"source": "github", "operation": "status"}, 403),
    ("remember", {"subject": "schema", "fact": "Patient NHI: ZAC5678"}, 422),
])
def test_confirmation_and_policy_are_enforced(name, args, expected):
    request = ToolRequest(session_id="s", user_id="a", turn_id="t", arguments=args, confirm=expected == 422)
    with pytest.raises(HTTPException) as error:
        run(execute(name, request))
    assert error.value.status_code == expected


def test_http_service_auth_and_successful_execution(monkeypatch):
    from main import app
    from config import settings
    monkeypatch.setattr("routes.capabilities.agent_runtime", lambda: SimpleNamespace(
        runner=SimpleNamespace(models=FakeRegistry()), store=InMemoryStore()))
    client = TestClient(app)
    for path in ("/ai/agents", "/ai/tools"):
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"x-internal-key": settings.INTERNAL_API_KEY}).status_code == 200
    body = {"session_id": "s", "user_id": "a", "turn_id": "t", "files": {"test.sql": "select 1"}}
    assert client.post("/ai/tools/list_files/execute", json=body).status_code == 401
    response = client.post("/ai/tools/list_files/execute", json=body,
                           headers={"x-internal-key": settings.INTERNAL_API_KEY})
    assert response.status_code == 200 and response.json()["ok"]
    assert "test.sql" in response.json()["result"]
