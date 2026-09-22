"""In-process stand-in for the backend, serving each case's synthetic data.

It implements ``workflow.gateway.BackendGateway`` and applies the same data
policy screening as ``HttpBackendGateway``, so agents see exactly what they
would see in production — without any request leaving the process.
"""
from __future__ import annotations

import json
from typing import Any

from workflow.gateway import screen_json


def artifact_page(content: str, args: dict[str, Any]) -> dict[str, Any]:
    """Python port of the backend's ``artifactPage`` (services/backend/src/services/impactEvidence.ts)."""
    offset = int(args.get("offset") or 0)
    target = str(args.get("target") or "").strip()
    if target:
        try:
            artifact = json.loads(content)
        except ValueError:
            artifact = None
        if isinstance(artifact, dict):
            sections = ("nodes", "sources", "exposures", "metrics", "semantic_models", "unit_tests", "saved_queries")
            entries = [(section, key, node) for section in sections
                       for key, node in (artifact.get(section) or {}).items()]
            exact = [e for e in entries if e[1] == target or e[2].get("name") == target]
            matches = exact or [e for e in entries if target.lower() in e[1].lower()
                                or target in (e[2].get("columns") or {})]
            page = matches[offset:offset + 5]

            def lineage(key: str, node: dict) -> dict[str, Any]:
                parents = (node.get("depends_on") or {}).get("nodes") or []
                children = [k for _, k, n in entries if key in ((n.get("depends_on") or {}).get("nodes") or [])]
                return {"parents": parents, "children": children}

            return {"target": target, "totalMatches": len(matches),
                    "nextOffset": offset + len(page) if offset + len(page) < len(matches) else None,
                    "matches": [{"section": s, "uniqueId": k, "evidence": json.dumps(n)[:30000], **lineage(k, n)}
                                for s, k, n in page],
                    "scope": "Matching nodes and immediate lineage only. Traverse parent/child IDs for "
                             "transitive impact; read raw pages for truncated node details."}
    page = content[offset:offset + 24000]
    return {"content": page, "offset": offset, "totalCharacters": len(content),
            "nextOffset": offset + len(page) if offset + len(page) < len(content) else None,
            "partial": offset > 0 or len(page) < len(content)}


class EvalGateway:
    def __init__(self, backend: dict[str, Any] | None = None):
        self.backend = backend or {}
        self.requests: list[tuple[str, str, dict]] = []

    async def github(self, operation: str, args: dict[str, Any]) -> str:
        self.requests.append(("github", operation, args))
        data = (self.backend.get("github") or {}).get(operation)
        if data is None:
            data = {"error": "GitHub is not connected. Connect it in Settings → Integrations.", "status": 409}
        if operation == "file" and isinstance(data, dict) and "files" in data:
            file = data["files"].get(args.get("path", ""))
            data = {**{k: v for k, v in data.items() if k != "files"}, "path": args.get("path"), "content": file} \
                if file is not None else {"error": "File not found at that path.", "status": 404}
        return screen_json("github-tool-result.json", data,
                           "GitHub content was blocked by the application's data policy. "
                           "No file content was passed to the model.")

    async def chat_search(self, operation: str, args: dict[str, Any]) -> str:
        self.requests.append(("chat_search", operation, args))
        data = (self.backend.get("chat_search") or {}).get(operation, {"matches": [], "files": [], "nextOffset": None})
        if isinstance(data, dict) and {"current", "all"} & set(data):
            data = data.get(args.get("scope", "current"), {"matches": [], "files": [], "nextOffset": None})
        return screen_json("chat-search.json", data, "Chat search content was blocked by data policy.")

    async def impact_evidence(self, grant: dict[str, Any], source: str, operation: str, args: dict[str, Any]) -> str:
        if grant.get("phase") != "confirmed" or source not in grant.get("sources", []):
            return json.dumps({"error": "This source has not been confirmed. "
                                        "Ask the user before changing evidence sources."})
        self.requests.append(("impact", f"{source}:{operation}", args))
        uploads = self.backend.get("uploads") or []
        if source == "uploads" and operation == "list":
            data: dict[str, Any] = {"source": source, "files": [{"id": u["id"], "filename": u["filename"], "version": 1}
                                                               for u in uploads], "nextOffset": None}
        elif source == "uploads" and operation == "read":
            upload = next((u for u in uploads if u["id"] == args.get("id")), None)
            data = ({"source": source, "id": upload["id"], "filename": upload["filename"], "version": 1,
                     **artifact_page(upload["content"], args)} if upload
                    else {"error": "File version is not attached to this chat.", "status": 404})
        elif source == "uploads":
            data = {"error": "Unsupported read-only evidence operation.", "status": 400}
        else:
            data = {"error": f"{source} is not connected. Connect it in Settings → Integrations or confirm "
                             "another source.", "status": 409}
        return screen_json("impact-evidence.json", data,
                           "Evidence was blocked by the data policy; no content was passed to the agent.")
