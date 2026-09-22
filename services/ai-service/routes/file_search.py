"""Embeddings use the same approved provider boundary as chat, after screening."""
import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from openai import AsyncOpenAI, AsyncAzureOpenAI, AzureOpenAI, OpenAI
from config import settings
import guardrails

router = APIRouter()

EMBEDDING_DIMENSIONS = 1536


class EmbeddingRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=16)


class EmbeddingUnavailable(RuntimeError):
    """This deployment has no approved embedding provider configured."""


def embedding_provider() -> tuple[str, str]:
    """(provider, model) for the approved embedding host, or raise."""
    provider = settings.EMBEDDING_PROVIDER or settings.LLM_PROVIDER
    host = settings.APPROVED_EMBEDDING_HOST or settings.APPROVED_LLM_HOST
    if provider == 'openai' and host == 'api.openai.com':
        return 'openai', 'text-embedding-3-small'
    if provider == 'azure' and settings.LLM_PROVIDER == 'azure' and os.getenv('AZURE_OPENAI_EMBEDDING_DEPLOYMENT'):
        # configure_llm validates this endpoint during startup.
        return 'azure', os.environ['AZURE_OPENAI_EMBEDDING_DEPLOYMENT']
    raise EmbeddingUnavailable('Semantic search is not configured for this provider')


def embed_texts_sync(texts: list[str]) -> list[list[float]]:
    """Blocking embedding call, for callers that already run off the event loop.

    The LangGraph store runs every operation in an executor, so its embedding
    callable must be synchronous; this shares the route's provider boundary.
    """
    provider, model = embedding_provider()
    client = (OpenAI(api_key=settings.OPENAI_API_KEY, base_url='https://api.openai.com/v1', timeout=45)
              if provider == 'openai' else
              AzureOpenAI(api_key=settings.AZURE_OPENAI_API_KEY, azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                          api_version=settings.AZURE_OPENAI_API_VERSION, timeout=45))
    with client:
        response = client.embeddings.create(model=model, input=texts, dimensions=EMBEDDING_DIMENSIONS)
    return [item.embedding for item in sorted(response.data, key=lambda item: item.index)]


@router.post('/files/embed')
async def embed_files(request: EmbeddingRequest):
    texts = []
    for text in request.texts:
        if not text.strip() or len(text) > 7000:
            raise HTTPException(400, 'Invalid search text size')
        checked = guardrails.screen_payload('', {'search.txt': text})
        if checked['guardrail']['decision'] == 'blocked':
            raise HTTPException(422, 'Search content blocked by policy')
        texts.append(checked['files']['search.txt'])
    try:
        provider, model = embedding_provider()
    except EmbeddingUnavailable as error:
        raise HTTPException(503, str(error))
    client = (AsyncOpenAI(api_key=settings.OPENAI_API_KEY, base_url='https://api.openai.com/v1', timeout=45)
              if provider == 'openai' else
              AsyncAzureOpenAI(api_key=settings.AZURE_OPENAI_API_KEY, azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                               api_version=settings.AZURE_OPENAI_API_VERSION, timeout=45))
    async with client:
        response = await client.embeddings.create(model=model, input=texts, dimensions=EMBEDDING_DIMENSIONS)
    return {'embeddings': [item.embedding for item in sorted(response.data, key=lambda item: item.index)]}
