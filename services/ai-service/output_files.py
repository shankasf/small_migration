"""Path-component allow-lists for anything joined onto OUTPUT_DIR.

``filename`` is chosen by a model and ``session_id`` arrives in a request body,
so neither may be joined onto a path unchecked: a traversal ("../") or absolute
("/app/...") value would escape OUTPUT_DIR — and pathlib drops the base
entirely when the joined part is absolute.
"""
import re
from pathlib import Path

SAFE_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def safe_join(base: Path, name: str) -> Path:
    """Join ``name`` onto ``base``, refusing anything that escapes ``base``."""
    if not SAFE_FILENAME.match(name) or ".." in name:
        raise ValueError(
            f"Invalid file name '{name}'. Use only letters, digits, dot, dash "
            "and underscore — no directory separators or parent references."
        )
    base_resolved = base.resolve()
    target = (base_resolved / name).resolve()
    if target.parent != base_resolved:
        raise ValueError(f"Invalid file name '{name}': path escapes the output folder.")
    return target
