"""Regional Titan embeddings, after the same content screening used by chat."""
import asyncio
import math
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from config import settings
import guardrails

router = APIRouter()
EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
EMBEDDING_DIMENSIONS = 1024
EMBEDDING_REGION = 'ap-southeast-2'
EMBEDDING_HOST = f'bedrock-runtime.{EMBEDDING_REGION}.amazonaws.com'
# Shared across requests and long-term memory; bound provider concurrency.
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='titan-embedding')


class EmbeddingRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=16)


class EmbeddingUnavailable(RuntimeError):
    """This deployment has no approved Titan embedding provider configured."""


def embedding_provider() -> tuple[str, str]:
    if (settings.EMBEDDING_PROVIDER != 'bedrock'
            or settings.APPROVED_EMBEDDING_HOST != EMBEDDING_HOST
            or settings.BEDROCK_REGION != EMBEDDING_REGION
            or not settings.AWS_BEARER_TOKEN_BEDROCK):
        raise EmbeddingUnavailable('Titan embeddings require the approved Sydney Bedrock endpoint and credential')
    return 'bedrock', EMBEDDING_MODEL


def _screen_texts(texts: list[str]) -> list[str]:
    screened = []
    for text in texts:
        if not text.strip() or len(text) > 7000:
            raise HTTPException(400, 'Invalid search text size')
        checked = guardrails.screen_payload('', {'search.txt': text})
        if checked['guardrail']['decision'] == 'blocked':
            raise HTTPException(422, 'Search content blocked by policy')
        screened.append(checked['files']['search.txt'])
    return screened


def _embed_one(text: str) -> list[float]:
    # Do not follow redirects with the credential. A failed request is retried
    # by the durable index worker, rather than silently switching providers.
    with httpx.Client(timeout=45, follow_redirects=False) as client:
        response = client.post(
            f'https://{EMBEDDING_HOST}/model/{EMBEDDING_MODEL}/invoke',
            headers={'Authorization': 'Bearer ' + settings.AWS_BEARER_TOKEN_BEDROCK},
            json={'inputText': text, 'dimensions': EMBEDDING_DIMENSIONS, 'normalize': True})
        response.raise_for_status()
        vector = response.json().get('embedding')
    if (not isinstance(vector, list) or len(vector) != EMBEDDING_DIMENSIONS
            or any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in vector)):
        raise ValueError('Invalid Titan embedding response')
    return vector


def embed_texts_sync(texts: list[str]) -> list[list[float]]:
    """Shared by search and LangGraph memory; preserve input order."""
    embedding_provider()
    screened = _screen_texts(texts)
    return list(_executor.map(_embed_one, screened))


@router.post('/files/embed')
async def embed_files(request: EmbeddingRequest):
    try:
        embeddings = await asyncio.to_thread(embed_texts_sync, request.texts)
    except EmbeddingUnavailable as error:
        raise HTTPException(503, str(error)) from None
    except (httpx.HTTPError, ValueError):
        # Provider errors can include input text or credential details.
        raise HTTPException(502, 'Titan embedding request failed') from None
    return {'embeddings': embeddings, 'model': EMBEDDING_MODEL,
            'dimensions': EMBEDDING_DIMENSIONS, 'region': EMBEDDING_REGION}
