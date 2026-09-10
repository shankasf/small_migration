"""Embeddings use the same approved provider boundary as chat, after screening."""
import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from openai import AsyncOpenAI, AsyncAzureOpenAI
from config import settings
import guardrails

router = APIRouter()


class EmbeddingRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=16)


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
    if settings.LLM_PROVIDER == 'openai' and settings.APPROVED_LLM_HOST == 'api.openai.com':
        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY, base_url='https://api.openai.com/v1', timeout=45)
        model = 'text-embedding-3-small'
    elif settings.LLM_PROVIDER == 'azure' and os.getenv('AZURE_OPENAI_EMBEDDING_DEPLOYMENT'):
        # configure_llm validates this endpoint during startup.
        client = AsyncAzureOpenAI(api_key=settings.AZURE_OPENAI_API_KEY,
                                 azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                                 api_version=settings.AZURE_OPENAI_API_VERSION, timeout=45)
        model = os.environ['AZURE_OPENAI_EMBEDDING_DEPLOYMENT']
    else:
        raise HTTPException(503, 'Semantic search is not configured for this provider')
    async with client:
        response = await client.embeddings.create(model=model, input=texts, dimensions=1536)
    return {'embeddings': [item.embedding for item in sorted(response.data, key=lambda item: item.index)]}
