"""Read-only access to the files attached to this turn (already screened)."""
from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from langgraph.prebuilt import ToolRuntime

from workflow.tools import logged, turn


@tool
async def list_files(runtime: ToolRuntime[Any]) -> str:
    """List the files attached to this turn."""
    files = turn(runtime).workspace.files

    async def body() -> str:
        return "Input files: " + (", ".join(files) if files else "None")
    return await logged(turn(runtime), "list_files", {}, body)


@tool
async def get_file_content(file_name: str, runtime: ToolRuntime[Any]) -> str:
    """Get the full content of an attached file by its exact label from list_files."""
    files = turn(runtime).workspace.files

    async def body() -> str:
        return files.get(file_name, f"File '{file_name}' not found.")
    return await logged(turn(runtime), "get_file_content", {"file_name": file_name}, body)


FILE_TOOLS = [list_files, get_file_content]
