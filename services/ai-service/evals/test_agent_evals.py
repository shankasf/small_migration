"""Core agent behaviours as LangSmith-tracked pytest cases (live Bedrock calls).

    RUN_AGENT_EVALS=1 python -m pytest evals/test_agent_evals.py -v

Skipped unless RUN_AGENT_EVALS=1. With LANGSMITH_API_KEY set, each test is an
example in the "circini-agent-evals" LangSmith suite and every run an
experiment; without it, results stay local.
"""
import asyncio
import os

import pytest

from evals import env

env.prepare()
if not os.environ.get("LANGSMITH_API_KEY"):
    os.environ.setdefault("LANGSMITH_TEST_TRACKING", "false")

from langsmith import testing as t  # noqa: E402

from evals import evaluators as ev  # noqa: E402
from evals.suites import SUITES  # noqa: E402

pytestmark = pytest.mark.skipif(os.environ.get("RUN_AGENT_EVALS") != "1",
                                reason="live agent evals; set RUN_AGENT_EVALS=1")


def cases(suite: str, *case_ids: str):
    examples = {e["metadata"]["case_id"]: e for e in SUITES[suite].examples()}
    return [pytest.param(examples[case_id], id=case_id) for case_id in case_ids]


def run(suite: str, example: dict) -> dict:
    t.log_inputs(example["inputs"])
    t.log_reference_outputs(example["outputs"])
    outputs = asyncio.run(SUITES[suite].target(example["inputs"]))
    t.log_outputs(outputs)
    return outputs


def log(results) -> None:
    for item in results if isinstance(results, list) else [results]:
        if item["score"] is not None:
            t.log_feedback(key=item["key"], score=item["score"])


@pytest.mark.langsmith(test_suite_name="circini-agent-evals")
@pytest.mark.parametrize("example", cases("router", "gen-ignore-old-mapping", "impact-rename", "impact-vague-yes",
                                          "history-followup", "repo-access", "oos-capital"))
def test_router_routes_each_intent(example):
    outputs = run("router", example)
    log(ev.route_correct(outputs, example["outputs"]))
    assert outputs["route"] == example["outputs"]["route"]


@pytest.mark.langsmith(test_suite_name="circini-agent-evals")
@pytest.mark.parametrize("example", cases("guard", "atk-audit-extraction", "atk-file-hidden-image", "atk-confirmation-bypass",
                                          "atk-image-exfil", "ok-ignore-old-mapping", "ok-own-history-recall",
                                          "ok-history-followup"))
def test_injection_guard_blocks_attacks_and_passes_real_work(example):
    outputs = run("guard", example)
    log(ev.guard_flag_correct(outputs, example["outputs"]))
    assert outputs["flagged"] == example["outputs"]["flagged"]


@pytest.mark.langsmith(test_suite_name="circini-agent-evals")
@pytest.mark.parametrize("example", cases("generation", "policies-clear", "file-after-read"))
def test_generation_delivers_every_mapped_field(example):
    outputs = run("generation", example)
    results = ev.generation_outcome(outputs, example["outputs"])
    log(results)
    assert all(item["score"] == 1 for item in results)


@pytest.mark.langsmith(test_suite_name="circini-agent-evals")
@pytest.mark.parametrize("example", cases("impact", "rename-customer-id"))
def test_impact_asks_for_sources_then_answers_from_evidence(example):
    outputs = run("impact", example)
    results = [ev.turn_expectations(outputs, example["outputs"]), *ev.impact_report(outputs, example["outputs"])]
    log(results)
    assert {item["key"]: item["score"] for item in results}["turn_expectations"] == 1
    assert {item["key"]: item["score"] for item in results}["required_assets"] >= 0.8
