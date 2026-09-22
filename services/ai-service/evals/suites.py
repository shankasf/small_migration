"""One suite per agent (or agent pipeline): dataset, target and evaluators."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from evals import evaluators as ev
from evals import targets

DATASET_DIR = Path(__file__).resolve().parent / "datasets"


@dataclass(frozen=True)
class Suite:
    name: str
    description: str
    target: Callable[[dict], Any]
    evaluators: list[Callable] = field(default_factory=list)
    summary_evaluators: list[Callable] = field(default_factory=list)

    @property
    def dataset_name(self) -> str:
        return f"circini-{self.name.replace('_', '-')}"

    def examples(self) -> list[dict[str, Any]]:
        lines = (DATASET_DIR / f"{self.name}.jsonl").read_text().splitlines()
        return [json.loads(line) for line in lines if line.strip()]


SUITES: dict[str, Suite] = {suite.name: suite for suite in [
    Suite("router", "Router Agent: route and new-analysis decision per turn (single step).",
          targets.router_target, [ev.route_correct], [ev.route_accuracy]),
    Suite("guard", "Rule-based intake + model-based Injection Guard: attacks caught, benign requests passed.",
          targets.guard_target, [ev.guard_flag_correct], [ev.guard_rates]),
    Suite("grant_judge", "Grant Judge: does a message continue the analysis whose sources were confirmed?",
          targets.grant_judge_target, [ev.grant_decision_correct]),
    Suite("generation", "Migration pipeline end to end: analyst, clarification pause, authors, validation, reviewer.",
          targets.conversation_target, [ev.generation_outcome, ev.no_active_content]),
    Suite("impact", "Impact pipeline end to end: source question, confirmation, investigator, reporter.",
          targets.conversation_target,
          [ev.turn_expectations, ev.impact_report, ev.no_active_content, ev.report_groundedness,
           ev.impact_correctness]),
    Suite("history", "History pipeline: recalls files from saved chats with chat search, never GitHub, "
                     "and hands over the file itself when asked.",
          targets.conversation_target,
          [ev.text_expectations, ev.tool_trajectory, ev.tool_policy, ev.delivered_files]),
    Suite("repository", "Repository Agent: verifies GitHub access with tools and cites repo, path and commit.",
          targets.conversation_target, [ev.text_expectations, ev.tool_trajectory, ev.tool_policy]),
    Suite("consult", "Migration Consultant: correctness of migration answers (LLM-as-judge, GPT-OSS).",
          targets.conversation_target, [ev.answer_correctness, ev.no_active_content]),
]}
