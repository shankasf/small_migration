"""
LLM provider wiring — config-gated (Deep's item 2).

LLM_PROVIDER=openai (default): the agents SDK uses the standard OpenAI client.
LLM_PROVIDER=azure: an AsyncAzureOpenAI client pointed at the configured
tenant/endpoint (e.g. HNZ's in-region Azure OpenAI) is installed as the SDK
default. Switching providers is an environment change only — no code change.
"""

from config import settings


def configure_llm() -> str:
    """Install the configured provider as the agents-SDK default client.

    Returns the model name (or Azure deployment name) agents should use.
    """
    if settings.LLM_PROVIDER == "azure":
        if not (settings.AZURE_OPENAI_ENDPOINT and settings.AZURE_OPENAI_API_KEY):
            raise RuntimeError(
                "LLM_PROVIDER=azure requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY"
            )
        from openai import AsyncAzureOpenAI
        from agents import set_default_openai_client, set_default_openai_api

        client = AsyncAzureOpenAI(
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
            api_key=settings.AZURE_OPENAI_API_KEY,
            api_version=settings.AZURE_OPENAI_API_VERSION,
        )
        # Azure OpenAI deployments speak the chat-completions API
        set_default_openai_client(client, use_for_tracing=False)
        set_default_openai_api("chat_completions")
        print(f"[LLM] Provider: azure ({settings.AZURE_OPENAI_ENDPOINT}, deployment={settings.model_name})")
    else:
        print(f"[LLM] Provider: openai (model={settings.model_name})")

    return settings.model_name
