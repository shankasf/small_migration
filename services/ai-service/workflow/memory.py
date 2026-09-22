"""Long-term memory: the LangGraph ``Store``, backed by DynamoDB.

Checkpoints are one chat's working state and expire after 30 days. This is the
other half of LangGraph's memory model: facts that outlive a chat, namespaced
per user, with no expiry. It is meant to accumulate for the life of the account
— there is no TTL and nothing prunes it — so recall must not get slower as it
grows:

- **Bounded recall.** Items are found by approximate nearest neighbour over a
  DynamoDB vector index (``search_vectors``), always ``limit``-capped, so a user
  with 20 items and a user with 200,000 cost the same to read.
- **Bounded writing.** A fact is keyed by its subject, so restating or changing
  a standing instruction replaces it instead of adding a near-duplicate.

The table is created by the stack; ``setup()`` only adds the vector index if it
is missing. Where the vector index is unavailable, the store still works: search
falls back to listing the user's namespace, which is why recall is always capped.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Optional

from langgraph.store.base import BaseStore
from langgraph.store.memory import InMemoryStore

from config import settings

# text-embedding-3-small through the service's approved embedding host, the
# same boundary and dimensions as chat-history search.
EMBEDDING_DIMENSIONS = 1536
# One subject, one memory: "target warehouse" restated is an update, not a new row.
SUBJECT = re.compile(r"[^a-z0-9]+")


def user_namespace(user_id: str) -> tuple[str, ...]:
    """LangGraph's namespace convention: a memory belongs to exactly one user."""
    return ("memories", user_id)


def subject_key(subject: str) -> str:
    """Case, spacing and punctuation must not make a second memory of one subject."""
    normalized = SUBJECT.sub("-", subject.strip().lower()).strip("-")
    # The slug keeps the key readable in the table; the digest keeps it unique.
    return f"{normalized[:80] or 'fact'}-{hashlib.sha256(normalized.encode()).hexdigest()[:12]}"


def embedding_function():
    """Sync embed callable, or None when the deployment has no embedding provider.

    The store's async API runs every operation in an executor, so a synchronous
    provider call here never blocks the event loop.
    """
    from routes.file_search import EmbeddingUnavailable, embed_texts_sync, embedding_provider

    try:
        embedding_provider()
    except EmbeddingUnavailable:
        return None
    return embed_texts_sync


def create_store() -> Optional[BaseStore]:
    """The long-term store, or None when this deployment runs without memory."""
    if not settings.MEMORY_ENABLED:
        return None
    index: dict[str, Any] | None = None
    embed = embedding_function()
    if embed is not None:
        index = {"embed": embed, "dims": EMBEDDING_DIMENSIONS, "fields": ["text"]}
    if settings.MEMORY_BACKEND == "memory":
        return InMemoryStore(index=index) if index else InMemoryStore()
    if settings.MEMORY_BACKEND != "dynamodb":
        raise RuntimeError(f"Unsupported MEMORY_BACKEND '{settings.MEMORY_BACKEND}'")
    if not settings.MEMORY_TABLE:
        raise RuntimeError("DynamoDB long-term memory needs MEMORY_TABLE")
    from langgraph_checkpoint_aws import DynamoDBStore

    # No TTL: a standing instruction is not stale because it is old.
    store = DynamoDBStore(table_name=settings.MEMORY_TABLE, region_name=settings.AWS_REGION,
                          **({"index": index} if index else {}))
    if index is None:
        return store
    try:
        # Idempotent: the stack owns the table, this adds the vector index once.
        store.setup()
        return store
    except Exception as error:  # noqa: BLE001 - any setup failure downgrades, never fails startup
        print(f'{{"event":"memory.vector_index_unavailable","error":"{type(error).__name__}"}}', flush=True)
        return DynamoDBStore(table_name=settings.MEMORY_TABLE, region_name=settings.AWS_REGION)
