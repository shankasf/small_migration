"""Read-only access to the files attached to this chat (already screened).

The backend sends every file of the session, plus any version the user picked
with @, on every turn. Tool results are capped (``security.TOOL_RESULT_MAX_CHARS``),
so a long file is read in pages: each page says which characters it holds and
the offset that continues it, instead of being cut without a way to go on.
"""
from __future__ import annotations

import re
from typing import Any

from langchain_core.tools import tool
from langgraph.prebuilt import ToolRuntime

import guardrails
from workflow.agents.formatting import looks_unparsed
from workflow.tools import logged, turn

PAGE_CHARS = 50_000
VERSION_LABEL = re.compile(r" \[v[1-9]\d*; [0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\]$")


def resolve(files: dict[str, str], file_name: str) -> tuple[str | None, str]:
    """(label, content) for an authorized attachment, or (None, error message)."""
    if file_name in files:
        return file_name, files[file_name]
    # Models sometimes omit the version/ID label returned by list_files. A
    # unique name is safe within this already authorized, immutable snapshot;
    # never search other sessions or choose a latest version as a fallback.
    matches = [label for label in files if VERSION_LABEL.sub("", label) == file_name]
    if len(matches) == 1:
        return matches[0], files[matches[0]]
    if matches:
        return None, (f"Multiple attached versions match '{file_name}'. "
                      "Call get_file_content with one exact label: " + "; ".join(matches))
    return None, (f"File '{file_name}' not found among this chat's attachments. "
                  "Call list_files and use an exact label.")


def attached_content(files: dict[str, str], file_name: str) -> str:
    """Resolve only this chat's authorized attachments, without choosing a version."""
    return resolve(files, file_name)[1]


def page_of(label: str, content: str, offset: int = 0, page: int = PAGE_CHARS) -> str:
    """One page of a file. A file that fits is returned unchanged; a partial page
    says exactly what it covers and how to continue.

    The whole file is screened before slicing, so a value split across a page
    boundary is still redacted.
    """
    if not content.strip():
        return f"File '{label}' is empty: no text was extracted from it."
    if looks_unparsed(content):
        return (f"File '{label}' could not be converted to text when it was uploaded, so its content is "
                "unavailable. Tell the user, and ask them to re-upload it (for a spreadsheet, as .xlsx or .csv).")
    checked = guardrails.check_outbound(content)
    content = checked.text
    # A file past the size ceiling is cut by the filter; the last page must say
    # so, or the model reads the cut point as the real end of the file.
    cut = (f" The file was cut by the security size limit: the remaining "
           f"{checked.truncated_from - len(content):,} characters are unavailable — tell the user."
           if checked.truncated_from else "")
    offset = max(0, int(offset or 0))
    if offset == 0 and len(content) <= page and not cut:
        return content
    if offset >= len(content):
        return f"Offset {offset:,} is past the end of '{label}' ({len(content):,} characters).{cut}"
    end = min(len(content), offset + page)
    body = content[offset:end]
    more = (f" More follows (truncated here): call get_file_content with offset={end} for the next page."
            if end < len(content) else " This is the last page." + cut)
    return f"[{label}: characters {offset:,}–{end:,} of {len(content):,}.{more}]\n{body}"


@tool
async def list_files(runtime: ToolRuntime[Any]) -> str:
    """List the files attached to this chat, with each one's size in characters."""
    files = turn(runtime).workspace.files

    async def body() -> str:
        if not files:
            return "Input files: None"
        sizes = "; ".join(f"{len(content):,} characters" + (" (empty)" if not content.strip() else "")
                          for content in files.values())
        return "Input files: " + ", ".join(files) + f"\nSizes, in the same order: {sizes}"
    return await logged(turn(runtime), "list_files", {}, body)


@tool
async def get_file_content(file_name: str, runtime: ToolRuntime[Any], offset: int = 0) -> str:
    """Get an attached file by its exact list_files label. A plain filename works only when unique among this chat's attachments; multiple versions require the exact label. Long files come in pages of 50,000 characters: pass the offset a page names to read the next one."""
    files = turn(runtime).workspace.files

    async def body() -> str:
        label, content = resolve(files, file_name)
        return page_of(label, content, offset) if label is not None else content
    args = {"file_name": file_name, **({"offset": offset} if offset else {})}
    return await logged(turn(runtime), "get_file_content", args, body)


FILE_TOOLS = [list_files, get_file_content]
