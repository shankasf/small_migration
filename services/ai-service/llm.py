"""Explicit provider selection; traces are only ever exported redacted."""
from urllib.parse import urlparse
import re
from config import settings


def security_status() -> dict:
    return {
        "provider": settings.LLM_PROVIDER,
        "model": settings.model_name,
        "agent_framework": "langgraph",
        "embedding_provider": settings.EMBEDDING_PROVIDER or settings.LLM_PROVIDER,
        "embedding_host": settings.APPROVED_EMBEDDING_HOST or settings.APPROVED_LLM_HOST,
        "approved_host": settings.APPROVED_LLM_HOST,
        "processing_region": settings.PROCESSING_REGION,
        "provider_approval_reference": settings.PROVIDER_APPROVAL_REFERENCE or None,
        "phi_enabled": False,
        "phi_ready": False,
        "phi_blockers": ["Independent PHI assessment and provider/network approvals required"],
        "guardrails_enabled": settings.GUARDRAILS_ENABLED,
        "sdk_tracing_enabled": settings.AGENT_TRACING_ENABLED,
        "trace_destination": urlparse(settings.LANGSMITH_ENDPOINT).hostname if settings.AGENT_TRACING_ENABLED else None,
        "trace_redaction": "guardrail-pii-and-secret-patterns" if settings.AGENT_TRACING_ENABLED else None,
        "checkpoint_backend": settings.CHECKPOINT_BACKEND,
        "voice_enabled": False,
        "policy_version": "2026-09-22.1",
    }


def configure_llm() -> str:
    """Refuse to start unless the configured provider is the approved one."""
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
    elif settings.LLM_PROVIDER == "bedrock":
        host = f"bedrock-runtime.{settings.BEDROCK_REGION}.amazonaws.com"
        if (not re.fullmatch(r"[a-z]{2}-[a-z]+-\d", settings.BEDROCK_REGION)
                or settings.APPROVED_LLM_HOST != host
                or settings.PROCESSING_REGION != settings.BEDROCK_REGION
                or not settings.AWS_BEARER_TOKEN_BEDROCK
                or settings.BEDROCK_MODEL != "openai.gpt-oss-120b-1:0"):
            raise RuntimeError("Bedrock requires the approved regional host, region, API key and GPT-OSS 120B model")
    elif settings.LLM_PROVIDER == "openai":
        if settings.APPROVED_LLM_HOST != "api.openai.com":
            raise RuntimeError("OpenAI endpoint does not match the approved host")
    else:
        raise RuntimeError("Unsupported LLM provider")
    return settings.model_name
