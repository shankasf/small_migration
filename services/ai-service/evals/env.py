"""Process environment for eval runs, applied before any service module is imported.

Settings are read at import time, so ``prepare()`` must run first. It only fills
gaps: CI and local runs supply the Bedrock configuration explicitly.
"""
import os
import sys
import tempfile
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent


def prepare() -> None:
    if str(SERVICE_ROOT) not in sys.path:
        sys.path.insert(0, str(SERVICE_ROOT))
    defaults = {
        # Checkpoints are deserialised against LangGraph's allow-list, as in production.
        "LANGGRAPH_STRICT_MSGPACK": "true",
        # Evals never touch DynamoDB: every case runs on its own in-memory thread.
        "CHECKPOINT_BACKEND": "memory",
        "OUTPUT_DIR": tempfile.mkdtemp(prefix="agent-evals-"),
        # The synthetic gateway replaces the backend; the key is never sent anywhere.
        "INTERNAL_API_KEY": "agent-evals-no-backend",
        "LLM_PROVIDER": "bedrock",
        "BEDROCK_REGION": "ap-southeast-2",
        "PROCESSING_REGION": "ap-southeast-2",
        "APPROVED_LLM_HOST": "bedrock-runtime.ap-southeast-2.amazonaws.com",
        "BEDROCK_MODEL": "openai.gpt-oss-120b-1:0",
    }
    for name, value in defaults.items():
        os.environ.setdefault(name, value)
    # aevaluate traces through its own client; environment-level tracing would
    # also trip the service's redaction check (workflow.tracing).
    for name in ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"):
        os.environ.pop(name, None)
