"""Retry policy for transient failures (network, throttling, provider 5xx).

Only transient errors retry. Parsing and validation failures are handled by the
LLM loop-back instead, and everything else bubbles up to the turn handler.
"""
from __future__ import annotations

import httpx
from langgraph.types import RetryPolicy

_TRANSIENT_AWS_CODES = {
    "ThrottlingException", "ServiceUnavailableException", "InternalServerException",
    "ModelNotReadyException", "ModelTimeoutException", "TooManyRequestsException",
}


def is_transient(error: BaseException) -> bool:
    try:
        from botocore.exceptions import ClientError, ConnectionError as BotoConnectionError, ReadTimeoutError
        if isinstance(error, (BotoConnectionError, ReadTimeoutError)):
            return True
        if isinstance(error, ClientError):
            return error.response.get("Error", {}).get("Code") in _TRANSIENT_AWS_CODES
    except ImportError:  # pragma: no cover - botocore ships with langchain-aws
        pass
    if isinstance(error, httpx.TransportError):
        return True
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in (429, 500, 502, 503, 504)
    try:
        import openai
        if isinstance(error, (openai.APIConnectionError, openai.RateLimitError, openai.InternalServerError)):
            return True
    except ImportError:  # pragma: no cover
        pass
    return False


# A model call that already spent the client's own retries gets two more
# attempts at node level, with backoff, before the turn fails.
LLM_RETRY = RetryPolicy(max_attempts=3, initial_interval=1.0, backoff_factor=2.0, retry_on=is_transient)
