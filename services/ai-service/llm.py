"""Explicit provider selection; SDK tracing is never allowed to export content."""
from urllib.parse import urlparse
from config import settings


def security_status() -> dict:
    return {
        "provider": settings.LLM_PROVIDER,
        "model": settings.model_name,
        "approved_host": settings.APPROVED_LLM_HOST,
        "processing_region": settings.PROCESSING_REGION,
        "provider_approval_reference": settings.PROVIDER_APPROVAL_REFERENCE or None,
        "phi_enabled": False,
        "phi_ready": False,
        "phi_blockers": ["Independent PHI assessment and provider/network approvals required"],
        "guardrails_enabled": settings.GUARDRAILS_ENABLED,
        "sdk_tracing_enabled": False,
        "voice_enabled": False,
        "policy_version": "2026-09-08.1",
    }


def configure_llm() -> str:
    from agents import set_tracing_disabled, set_default_openai_client, set_default_openai_api
    from openai import AsyncAzureOpenAI, AsyncOpenAI
    set_tracing_disabled(True)
    if not settings.GUARDRAILS_ENABLED:
        raise RuntimeError("Guardrails cannot be disabled")
    # Redaction cannot establish that arbitrary clinical narratives are de-identified.
    # PHI stays unavailable until separately assessed and implemented for that use.
    if settings.PHI_MODE or settings.VOICE_ENABLED:
        raise RuntimeError("PHI and voice processing are unavailable pending an approved data boundary")
    if settings.LLM_PROVIDER == "azure":
        endpoint = urlparse(settings.AZURE_OPENAI_ENDPOINT)
        if (endpoint.scheme != "https" or endpoint.hostname != settings.APPROVED_LLM_HOST
                or endpoint.username or endpoint.password or endpoint.port not in (None, 443)
                or endpoint.query or endpoint.fragment or endpoint.path not in ("", "/")
                or not endpoint.hostname.endswith(".openai.azure.com")
                or not settings.AZURE_OPENAI_API_KEY or not settings.AZURE_OPENAI_DEPLOYMENT
                or settings.PROCESSING_REGION == "unverified" or not settings.PROVIDER_APPROVAL_REFERENCE):
            raise RuntimeError("Azure requires an approved HTTPS resource, deployment, region and approval reference")
        client = AsyncAzureOpenAI(azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                                 api_key=settings.AZURE_OPENAI_API_KEY,
                                 api_version=settings.AZURE_OPENAI_API_VERSION)
        set_default_openai_api("chat_completions")
    elif settings.LLM_PROVIDER == "openai":
        if settings.APPROVED_LLM_HOST != "api.openai.com":
            raise RuntimeError("OpenAI endpoint does not match the approved host")
        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY, base_url="https://api.openai.com/v1")
    else:
        raise RuntimeError("Unsupported LLM provider")
    set_default_openai_client(client, use_for_tracing=False)
    return settings.model_name
