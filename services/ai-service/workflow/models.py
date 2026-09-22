"""Chat model construction: one provider strategy, one profile per agent role.

``llm.validate_provider_configuration`` has already refused any provider that
is not approved for this deployment; the providers here only build clients for
the approved endpoint. Agents never construct models themselves — they ask the
``ModelRegistry`` in the runtime context, which is what lets tests and evals
substitute a fake model without touching agent code.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from langchain_core.language_models import BaseChatModel

from config import settings


class ModelRole(StrEnum):
    ROUTER = "router"
    GUARD = "guard"
    GRANT_JUDGE = "grant_judge"
    HISTORY = "history"
    REPOSITORY = "repository"
    CONSULTANT = "consultant"
    ANALYST = "analyst"
    AUTHOR = "author"
    REVIEWER = "reviewer"
    INVESTIGATOR = "investigator"
    REPORTER = "reporter"


@dataclass(frozen=True)
class ModelProfile:
    max_tokens: int
    reasoning_effort: str = "low"


# SQL generation and review get more reasoning; classification stays cheap.
PROFILES: dict[ModelRole, ModelProfile] = {
    ModelRole.ROUTER: ModelProfile(max_tokens=1500),
    ModelRole.GUARD: ModelProfile(max_tokens=1000),
    ModelRole.GRANT_JUDGE: ModelProfile(max_tokens=1500),
    ModelRole.HISTORY: ModelProfile(max_tokens=4000),
    ModelRole.REPOSITORY: ModelProfile(max_tokens=8000),
    ModelRole.CONSULTANT: ModelProfile(max_tokens=16000),
    ModelRole.ANALYST: ModelProfile(max_tokens=16000),
    ModelRole.AUTHOR: ModelProfile(max_tokens=16000, reasoning_effort="medium"),
    ModelRole.REVIEWER: ModelProfile(max_tokens=8000, reasoning_effort="medium"),
    ModelRole.INVESTIGATOR: ModelProfile(max_tokens=16000),
    ModelRole.REPORTER: ModelProfile(max_tokens=16000),
}


class ChatModelProvider(Protocol):
    name: str
    model_name: str

    def create(self, profile: ModelProfile) -> BaseChatModel: ...


class BedrockConverseProvider:
    """Bedrock Converse API (the integration LangChain's Bedrock docs recommend)."""

    name = "bedrock"

    def __init__(self) -> None:
        self.model_name = settings.model_name

    def create(self, profile: ModelProfile) -> BaseChatModel:
        from botocore.config import Config
        from langchain_aws import ChatBedrockConverse

        return ChatBedrockConverse(
            model=settings.BEDROCK_MODEL,
            region_name=settings.BEDROCK_REGION,
            # The approved regional host, pinned rather than left to endpoint discovery.
            endpoint_url=f"https://{settings.APPROVED_LLM_HOST}",
            bedrock_api_key=settings.AWS_BEARER_TOKEN_BEDROCK,
            temperature=0,
            max_tokens=profile.max_tokens,
            reasoning_effort=profile.reasoning_effort,
            config=Config(read_timeout=180, connect_timeout=10,
                          retries={"mode": "standard", "max_attempts": 3}),
        )


class OpenAIProvider:
    name = "openai"

    def __init__(self) -> None:
        self.model_name = settings.model_name

    def create(self, profile: ModelProfile) -> BaseChatModel:
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=settings.OPENAI_MODEL, api_key=settings.OPENAI_API_KEY,
            base_url="https://api.openai.com/v1", use_responses_api=True, store=False,
            reasoning={"effort": profile.reasoning_effort}, max_tokens=profile.max_tokens,
            timeout=180, max_retries=3,
        )


class AzureOpenAIProvider:
    name = "azure"

    def __init__(self) -> None:
        self.model_name = settings.model_name

    def create(self, profile: ModelProfile) -> BaseChatModel:
        from langchain_openai import AzureChatOpenAI

        return AzureChatOpenAI(
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT, api_key=settings.AZURE_OPENAI_API_KEY,
            api_version=settings.AZURE_OPENAI_API_VERSION, azure_deployment=settings.AZURE_OPENAI_DEPLOYMENT,
            reasoning_effort=profile.reasoning_effort, max_tokens=profile.max_tokens,
            timeout=180, max_retries=3,
        )


PROVIDERS: dict[str, type] = {
    "bedrock": BedrockConverseProvider,
    "openai": OpenAIProvider,
    "azure": AzureOpenAIProvider,
}


class ModelRegistry:
    """Builds each role's model once and hands the same instance to every run."""

    def __init__(self, provider: ChatModelProvider, profiles: dict[ModelRole, ModelProfile] = PROFILES):
        self.provider = provider
        self._profiles = profiles
        self._models: dict[ModelRole, BaseChatModel] = {}

    @property
    def provider_name(self) -> str:
        return self.provider.name

    @property
    def model_name(self) -> str:
        return self.provider.model_name

    def get(self, role: ModelRole) -> BaseChatModel:
        if role not in self._models:
            self._models[role] = self.provider.create(self._profiles[role])
        return self._models[role]


def default_registry() -> ModelRegistry:
    return ModelRegistry(PROVIDERS[settings.LLM_PROVIDER]())
