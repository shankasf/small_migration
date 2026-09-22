"""
Configuration for AI Service
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load service-local .env first, then fall back to the repo root .env
load_dotenv(Path(__file__).parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env")


def _bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes", "on")


class Settings:
    # --- LLM provider (config-gated so the client's in-tenant models, e.g.
    # HNZ Azure OpenAI, can be used with no code change) ---
    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "openai").strip().lower()  # openai | azure | bedrock
    BEDROCK_REGION: str = os.getenv("BEDROCK_REGION", "ap-southeast-2")
    BEDROCK_MODEL: str = os.getenv("BEDROCK_MODEL", "openai.gpt-oss-120b-1:0")
    AWS_BEARER_TOKEN_BEDROCK: str = os.getenv("AWS_BEARER_TOKEN_BEDROCK", "")
    # Preserve the existing vector space when chat uses a text-only model.
    EMBEDDING_PROVIDER: str = os.getenv("EMBEDDING_PROVIDER", "")
    APPROVED_EMBEDDING_HOST: str = os.getenv("APPROVED_EMBEDDING_HOST", "")

    # OpenAI (LLM_PROVIDER=openai)
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "gpt-6-astra")

    # Azure OpenAI (LLM_PROVIDER=azure) — point these at the client's tenant
    AZURE_OPENAI_ENDPOINT: str = os.getenv("AZURE_OPENAI_ENDPOINT", "")
    AZURE_OPENAI_API_KEY: str = os.getenv("AZURE_OPENAI_API_KEY", "")
    AZURE_OPENAI_API_VERSION: str = os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21")
    AZURE_OPENAI_DEPLOYMENT: str = os.getenv("AZURE_OPENAI_DEPLOYMENT", "")

    # Processing approval is an operator-reviewed evidence reference, not a claim
    # that an environment variable can establish a provider contract.
    APPROVED_LLM_HOST: str = os.getenv("APPROVED_LLM_HOST", "api.openai.com")
    PROCESSING_REGION: str = os.getenv("PROCESSING_REGION", "unverified")
    PROVIDER_APPROVAL_REFERENCE: str = os.getenv("PROVIDER_APPROVAL_REFERENCE", "")
    PHI_APPROVAL_REFERENCE: str = os.getenv("PHI_APPROVAL_REFERENCE", "")
    VOICE_ENABLED: bool = _bool("VOICE_ENABLED", "false")
    # --- Guardrails ---
    GUARDRAILS_ENABLED: bool = _bool("GUARDRAILS_ENABLED", "true")
    # Mode A (default): health PII is blocked outright before model egress.
    # Mode B (PHI_MODE=true): health PII is redacted, request proceeds.
    PHI_MODE: bool = _bool("PHI_MODE", "false")
    MAX_INPUT_CHARS: int = int(os.getenv("MAX_INPUT_CHARS", "500000"))

    # --- Agent runtime (LangGraph) ---
    # Checkpoints hold each chat thread's paused questions and generated drafts.
    # "dynamodb" in AWS; "memory" only for local runs and tests (lost on restart).
    CHECKPOINT_BACKEND: str = os.getenv("CHECKPOINT_BACKEND", "memory").strip().lower()
    CHECKPOINT_TABLE: str = os.getenv("CHECKPOINT_TABLE", "")
    CHECKPOINT_BUCKET: str = os.getenv("CHECKPOINT_BUCKET", "")
    CHECKPOINT_TTL_DAYS: int = int(os.getenv("CHECKPOINT_TTL_DAYS", "30"))
    AWS_REGION: str = os.getenv("AWS_REGION", os.getenv("BEDROCK_REGION", "ap-southeast-2"))
    # Memory is bounded by turns in flight, not by agent count: each turn holds
    # its screened files in memory, so turns beyond this wait for a slot.
    MAX_CONCURRENT_TURNS: int = int(os.getenv("MAX_CONCURRENT_TURNS", "4"))
    MAX_PARALLEL_TASKS: int = int(os.getenv("MAX_PARALLEL_TASKS", "3"))
    MAX_REVISIONS: int = int(os.getenv("MAX_REVISIONS", "2"))

    # --- LangSmith tracing (content is redacted with the guardrail patterns) ---
    AGENT_TRACING_ENABLED: bool = _bool("AGENT_TRACING_ENABLED", "false")
    LANGSMITH_API_KEY: str = os.getenv("LANGSMITH_API_KEY", "")
    LANGSMITH_ENDPOINT: str = os.getenv("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com").rstrip("/")
    LANGSMITH_PROJECT: str = os.getenv("LANGSMITH_PROJECT", "circini-migration-agent")

    # --- Telemetry ---
    OTEL_ENABLED: bool = _bool("OTEL_ENABLED", "true")
    OTEL_SERVICE_NAME: str = os.getenv("OTEL_SERVICE_NAME", "circini-ai-service")
    OTEL_EXPORTER_OTLP_ENDPOINT: str = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")

    # --- Service auth (backend <-> AI service shared key) ---
    INTERNAL_API_KEY: str = os.getenv("INTERNAL_API_KEY", "")

    # Server settings
    PORT: int = int(os.getenv("PORT", "8084"))

    # Backend URL for sending logs
    BACKEND_URL: str = os.getenv("BACKEND_URL", "http://backend:3001")

    # Output directory (PersistentVolume mount point in k8s)
    OUTPUT_DIR: Path = Path(os.getenv("OUTPUT_DIR", "/data/outputs"))

    @property
    def model_name(self) -> str:
        """Model (or Azure deployment) the agent should run against."""
        if self.LLM_PROVIDER == "azure":
            return self.AZURE_OPENAI_DEPLOYMENT or self.OPENAI_MODEL
        if self.LLM_PROVIDER == "bedrock":
            return self.BEDROCK_MODEL
        return self.OPENAI_MODEL

    def __init__(self):
        # Ensure output directory exists
        self.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


settings = Settings()
