"""
Test environment setup.

config.py creates OUTPUT_DIR at import time and defaults it to /data/outputs,
which exists in the container but not on a CI runner. pytest imports conftest
before any test module, so setting these here keeps the suite runnable
anywhere without depending on ambient environment or a .env file.
"""

import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tempfile

os.environ.setdefault("OUTPUT_DIR", tempfile.mkdtemp(prefix="ai-service-tests-"))
# Read by LangGraph at import time; production sets it the same way.
os.environ["LANGGRAPH_STRICT_MSGPACK"] = "true"
os.environ["CHECKPOINT_BACKEND"] = "memory"
for tracing in ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"):
    os.environ.pop(tracing, None)
# Placeholders: the suite never calls a model provider, but config reads these.
os.environ.setdefault("OPENAI_API_KEY", "sk-test-placeholder-not-a-real-key")
os.environ.setdefault("INTERNAL_API_KEY", "test-internal-key")

# Guardrail tests assert the shipped defaults; pin them so a stray local .env
# cannot make the suite pass or fail for the wrong reason.
os.environ["GUARDRAILS_ENABLED"] = "true"
os.environ["PHI_MODE"] = "false"
