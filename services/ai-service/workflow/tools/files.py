"""Read-only access to the files attached to this turn (already screened)."""
from __future__ import annotations

import re
from typing import Any

from langchain_core.tools import tool
from langgraph.prebuilt import ToolRuntime

from workflow.tools import logged, turn

VERSION_LABEL = re.compile(r" \[v[1-9]\d*; [0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\]$")


def attached_content(files: dict[str, str], file_name: str) -> str:
    """Resolve only this turn's authorized attachments, without choosing a version."""
    if file_name in files:
        return files[file_name]
    # Models sometimes omit the version/ID label returned by list_files. A
    # unique name is safe within this already authorized, immutable snapshot;
    # never search other sessions or choose a latest version as a fallback.
    matches = [label for label in files if VERSION_LABEL.sub("", label) == file_name]
    if len(matches) == 1:
        return files[matches[0]]
    if matches:
        return (f"Multiple attached versions match '{file_name}'. "
                "Call get_file_content with one exact label: " + "; ".join(matches))
    return (f"File '{file_name}' not found among this turn's attachments. "
            "Call list_files and use an exact label.")


@tool
async def list_files(runtime: ToolRuntime[Any]) -> str:
    """List the files attached to this turn."""
    files = turn(runtime).workspace.files

    async def body() -> str:
        return "Input files: " + (", ".join(files) if files else "None")
    return await logged(turn(runtime), "list_files", {}, body)


@tool
async def get_file_content(file_name: str, runtime: ToolRuntime[Any]) -> str:
    """Get an attached file by its exact list_files label. A plain filename works only when unique among this turn's attachments; multiple versions require the exact label."""
    files = turn(runtime).workspace.files

    async def body() -> str:
        return attached_content(files, file_name)
    return await logged(turn(runtime), "get_file_content", {"file_name": file_name}, body)


FILE_TOOLS = [list_files, get_file_content]
