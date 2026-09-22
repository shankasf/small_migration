"""Checkpointer selection.

Production uses DynamoDB (``langgraph-checkpoint-aws``): IAM-scoped to one
table, expired by DynamoDB TTL, with payloads over the 400 KB item limit
offloaded to an S3 bucket whose lifecycle rule the stack owns. The AI service
never holds database credentials.
"""
from __future__ import annotations

import os

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver

from config import settings


def create_checkpointer() -> BaseCheckpointSaver:
    # Checkpoints are deserialised with an allow-list, never arbitrary types.
    if os.environ.get("LANGGRAPH_STRICT_MSGPACK", "").lower() not in ("1", "true", "yes"):
        raise RuntimeError("LANGGRAPH_STRICT_MSGPACK=true is required")
    if settings.CHECKPOINT_BACKEND == "memory":
        return InMemorySaver()
    if settings.CHECKPOINT_BACKEND == "dynamodb":
        if not settings.CHECKPOINT_TABLE or not settings.CHECKPOINT_BUCKET:
            raise RuntimeError("DynamoDB checkpoints need CHECKPOINT_TABLE and CHECKPOINT_BUCKET")
        from langgraph_checkpoint_aws import DynamoDBSaver
        return DynamoDBSaver(
            table_name=settings.CHECKPOINT_TABLE,
            region_name=settings.AWS_REGION,
            ttl_seconds=settings.CHECKPOINT_TTL_DAYS * 86400,
            enable_checkpoint_compression=True,
            s3_offload_config={"bucket_name": settings.CHECKPOINT_BUCKET},
        )
    raise RuntimeError(f"Unsupported CHECKPOINT_BACKEND '{settings.CHECKPOINT_BACKEND}'")
