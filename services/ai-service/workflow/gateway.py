"""Backend gateway: the only way agents read GitHub, chat history or evidence.

The acting user and session come from the authenticated turn, never from a
model-supplied tool argument. Every response crosses the same data-policy
boundary as an upload before it can reach a model, and failures return
sanitised messages (exception text can carry request headers).
"""
from __future__ import annotations

import json
from typing import Any, Protocol

import httpx

import guardrails
from config import settings

IMPACT_SOURCES = ("uploads", "history", "github", "gitlab", "dbt", "snowflake")


class BackendGateway(Protocol):
    async def github(self, operation: str, args: dict[str, Any]) -> str: ...

    async def chat_search(self, operation: str, args: dict[str, Any]) -> str: ...

    async def impact_evidence(self, grant: dict[str, Any], source: str, operation: str,
                              args: dict[str, Any]) -> str: ...


def screen_json(label: str, data: Any, blocked_message: str) -> str:
    """Pass a backend payload through the upload policy before model egress."""
    checked = guardrails.screen_payload("", {label: json.dumps(data, ensure_ascii=False)})
    if checked["guardrail"]["decision"] == "blocked":
        return json.dumps({"error": blocked_message})
    return checked["files"][label]


class HttpBackendGateway:
    def __init__(self, session_id: str, actor_id: str | None, *,
                 base_url: str | None = None, internal_key: str | None = None,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.session_id = session_id
        self.actor_id = actor_id
        self.base_url = (base_url or settings.BACKEND_URL).rstrip("/")
        self.internal_key = settings.INTERNAL_API_KEY if internal_key is None else internal_key
        self.transport = transport

    async def _post(self, path: str, body: dict[str, Any], timeout: float) -> httpx.Response:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=self.transport) as client:
            return await client.post(f"{self.base_url}{path}/{self.session_id}",
                                     headers={"x-internal-key": self.internal_key}, json=body)

    async def github(self, operation: str, args: dict[str, Any]) -> str:
        if not self.actor_id or not self.internal_key:
            return json.dumps({"error": "GitHub access is unavailable until you sign in to an authorized chat."})
        try:
            response = await self._post("/api/internal/github",
                                        {"user_id": self.actor_id, "operation": operation, "args": args}, 60.0)
            if response.status_code != 200:
                # Backend errors are already sanitised; they still cross the policy boundary.
                data = {"error": response.json().get("error", "GitHub read could not be completed."),
                        "status": response.status_code}
            else:
                data = response.json()
            return screen_json("github-tool-result.json", data,
                               "GitHub content was blocked by the application's data policy. "
                               "No file content was passed to the model.")
        except (httpx.HTTPError, ValueError, TypeError, KeyError):
            return json.dumps({"error": "GitHub service is temporarily unavailable. "
                                        "Retry or check Settings → Integrations."})

    async def chat_search(self, operation: str, args: dict[str, Any]) -> str:
        if not self.actor_id or not self.internal_key:
            return json.dumps({"error": "Chat search requires an authenticated session."})
        try:
            response = await self._post("/api/internal/chat-search",
                                        {"user_id": self.actor_id, "operation": operation, "args": args}, 90.0)
            data = response.json() if response.status_code == 200 else {
                "error": response.json().get("error", "Chat search unavailable."), "status": response.status_code}
            return screen_json("chat-search.json", data, "Chat search content was blocked by data policy.")
        except (httpx.HTTPError, ValueError, TypeError, KeyError):
            return json.dumps({"error": "Chat search is temporarily unavailable. "
                                        "Do not interpret this as no matching history."})

    async def impact_evidence(self, grant: dict[str, Any], source: str, operation: str,
                              args: dict[str, Any]) -> str:
        # The backend re-checks the grant; refusing here keeps an unconfirmed
        # source from costing a request at all.
        if grant.get("phase") != "confirmed" or source not in grant.get("sources", []):
            return json.dumps({"error": "This source has not been confirmed. "
                                        "Ask the user before changing evidence sources."})
        try:
            response = await self._post("/api/internal/impact",
                                        {"user_id": self.actor_id, "analysis_id": grant["id"], "source": source,
                                         "operation": operation, "args": args}, 60.0)
            return screen_json("impact-evidence.json", response.json(),
                               "Evidence was blocked by the data policy; no content was passed to the agent.")
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return json.dumps({"error": "Evidence source is unavailable. Do not treat this as absence of "
                                        "dependencies or switch sources without confirmation."})
