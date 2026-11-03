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
    # Embeddings are independent of the chat model and stay in Sydney.
    EMBEDDING_PROVIDER: str = os.getenv("EMBEDDING_PROVIDER", "bedrock")
    APPROVED_EMBEDDING_HOST: str = os.getenv("APPROVED_EMBEDDING_HOST", "bedrock-runtime.ap-southeast-2.amazonaws.com")

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
    # Long-term memory (LangGraph Store): standing instructions that outlive a
    # chat. Kept for the life of the account — no TTL — so recall is always
    # limit-capped and a restated fact replaces the old one.
    MEMORY_ENABLED: bool = _bool("MEMORY_ENABLED", "true")
    MEMORY_BACKEND: str = os.getenv("MEMORY_BACKEND", "memory").strip().lower()
    MEMORY_TABLE: str = os.getenv("MEMORY_TABLE", "")
    MEMORY_RECALL_LIMIT: int = int(os.getenv("MEMORY_RECALL_LIMIT", "5"))
    MEMORY_WRITES_PER_TURN: int = int(os.getenv("MEMORY_WRITES_PER_TURN", "3"))
    MEMORY_FACT_MAX_CHARS: int = int(os.getenv("MEMORY_FACT_MAX_CHARS", "500"))
    # Conversation summarisation: how much recent chat is kept verbatim before
    # older turns are folded into a running summary.
    SUMMARY_TRIGGER_CHARS: int = int(os.getenv("SUMMARY_TRIGGER_CHARS", "60000"))
    SUMMARY_KEEP_CHARS: int = int(os.getenv("SUMMARY_KEEP_CHARS", "30000"))
    AWS_REGION: str = os.getenv("AWS_REGION", os.getenv("BEDROCK_REGION", "ap-southeast-2"))
    # Memory is bounded by turns in flight, not by agent count: each turn holds
    # its screened files in memory, so turns beyond this wait for a slot.
    MAX_CONCURRENT_TURNS: int = int(os.getenv("MAX_CONCURRENT_TURNS", "4"))
    MAX_PARALLEL_TASKS: int = int(os.getenv("MAX_PARALLEL_TASKS", "3"))
    MAX_REVISIONS: int = int(os.getenv("MAX_REVISIONS", "2"))
    # Output cap for the model author. Reasoning tokens count against it, and
    # GPT-OSS 120B on Bedrock allows at most 16K output tokens per call, so a
    # long model is recovered by reasoning less (AUTHOR_RECOVERY_EFFORT on the
    # attempt after a cut-off reply), not by raising this past the model limit.
    AUTHOR_MAX_TOKENS: int = int(os.getenv("AUTHOR_MAX_TOKENS", "16000"))
    AUTHOR_REASONING_EFFORT: str = os.getenv("AUTHOR_REASONING_EFFORT", "medium").strip().lower()
    AUTHOR_RECOVERY_EFFORT: str = os.getenv("AUTHOR_RECOVERY_EFFORT", "low").strip().lower()

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
