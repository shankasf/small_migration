"""In-process stand-in for the backend, serving each case's synthetic data.

It implements ``workflow.gateway.BackendGateway`` and applies the same data
policy screening as ``HttpBackendGateway``, so agents see exactly what they
would see in production — without any request leaving the process.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from workflow.gateway import screen_json

REPOS = Path(__file__).resolve().parent / "repos"
BLOCKED = object()  # a file the data policy blocks in production


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
    return {"content": page, "offset": offset, "startLine": content[:offset].count("\n") + 1,
            "totalCharacters": len(content),
            "nextOffset": offset + len(page) if offset + len(page) < len(content) else None,
            "partial": offset > 0 or len(page) < len(content)}


class RepoSnapshot:
    """A GitHub repository served with the backend's readGitHub response shapes
    (services/backend/src/services/githubAgent.ts)."""

    def __init__(self, spec: dict[str, Any]):
        root = REPOS / spec["snapshot"]
        self.files: dict[str, Any] = {str(p.relative_to(root)): p.read_text() for p in sorted(root.rglob("*"))
                                      if p.is_file() and p.name != "SNAPSHOT.md"}
        for path in spec.get("blocked_paths", []):
            self.files[path] = BLOCKED
        self.full_name, self.branch = spec["full_name"], spec.get("branch", "main")
        self.id, self.installation_id = spec.get("id", 4101), spec.get("installation_id", 7202)
        self.commit_sha = spec["commit_sha"]
        self.others = spec.get("other_repositories", [])
        self.selected = spec.get("selected", False)

    def repository(self) -> dict[str, Any]:
        return {"id": self.id, "installationId": self.installation_id, "fullName": self.full_name,
                "private": True, "defaultBranch": self.branch}

    def read(self, operation: str, args: dict[str, Any]) -> dict[str, Any]:
        selected = {**self.repository(), "branch": self.branch} if self.selected else None
        context = {"status": "connected", "selectedRepository": selected}
        if operation == "status":
            return {**context, "selectedCommitSha": self.commit_sha if selected else None, "verified": True,
                    "installationCount": 1, "capabilities": ["list_repositories", "list_files", "read_file"]}
        if operation == "repositories":
            return {"repositories": [self.repository(), *self.others],
                    "pages": [{"installationId": self.installation_id, "page": 1, "hasMore": False}],
                    "selectedRepository": selected}
        repository_id = int(args.get("repository_id") or 0) or (self.id if selected else 0)
        if repository_id != self.id:
            return {"error": "Select a repository in Settings → Integrations or use IDs returned by "
                             "list_github_repositories.", "status": 400}
        ref = str(args.get("ref") or self.branch)
        if ref not in (self.branch, self.commit_sha):
            return {"error": "Branch or commit not found.", "status": 404}
        provenance = {"repository": self.full_name, "repositoryId": self.id, "installationId": self.installation_id,
                      "ref": ref, "commitSha": self.commit_sha}
        if operation == "tree":
            prefix = str(args.get("path") or "").rstrip("/")
            offset = int(args.get("offset") or 0)
            paths = [p for p in self.files if not prefix or p == prefix or p.startswith(prefix + "/")]
            page = paths[offset:offset + 500]
            return {**provenance, "entries": [{"path": p, "type": "blob", "size": len(str(self.files[p])),
                                               "sha": hashlib.sha256(p.encode()).hexdigest()[:40]} for p in page],
                    "offset": offset, "hasMore": offset + 500 < len(paths),
                    "nextOffset": offset + 500 if offset + 500 < len(paths) else None, "truncated": False}
        path = str(args.get("path") or "")
        if path not in self.files:
            return {"error": "File not found at that path.", "status": 404}
        return {**provenance, "path": path, "blobSha": hashlib.sha256(path.encode()).hexdigest()[:40],
                "content": self.files[path]}


class EvalGateway:
    def __init__(self, backend: dict[str, Any] | None = None):
        self.backend = backend or {}
        self.requests: list[tuple[str, str, dict]] = []
        self.repo = RepoSnapshot(self.backend["github_repo"]) if self.backend.get("github_repo") else None

    @staticmethod
    def _screen_repo_read(label: str, data: dict[str, Any], blocked: str) -> str:
        if data.get("content") is BLOCKED:  # production screening blocks this file's identifiers
            return json.dumps({"error": blocked})
        return screen_json(label, data, blocked)

    async def github(self, operation: str, args: dict[str, Any]) -> str:
        self.requests.append(("github", operation, args))
        if self.repo:
            return self._screen_repo_read("github-tool-result.json", self.repo.read(operation, args),
                                          "GitHub content was blocked by the application's data policy. "
                                          "No file content was passed to the model.")
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
        elif source == "github" and self.repo:
            if operation not in ("status", "repositories", "tree", "file"):
                data = {"error": "Read-only GitHub operation required.", "status": 400}
            else:
                result = self.repo.read(operation, args)
                if isinstance(result.get("content"), str):
                    content = result.pop("content")
                    result = {**result, **artifact_page(content, args)}
                data = {"source": source, **result}
            return self._screen_repo_read("impact-evidence.json", data,
                                          "Evidence was blocked by the data policy; no content was passed to the agent.")
        else:
            data = {"error": f"{source} is not connected. Connect it in Settings → Integrations or confirm "
                             "another source.", "status": 409}
        return screen_json("impact-evidence.json", data,
                           "Evidence was blocked by the data policy; no content was passed to the agent.")
