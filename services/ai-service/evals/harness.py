"""Run a suite in LangSmith (``aevaluate``) or locally, and score the results the same way.

LangSmith mode syncs the JSONL dataset into a versioned LangSmith dataset and
records an experiment. Local mode (no API key, or ``--no-upload``) runs the same
targets and evaluators in-process and sends nothing anywhere — ``aevaluate``
itself still tries to ingest traces without a key, so it is not used there.
"""
from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from evals.suites import Suite

EVALUATOR_ARGS = ("inputs", "outputs", "reference_outputs")


@dataclass
class CaseResult:
    case_id: str
    outputs: dict[str, Any] | None
    feedback: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    seconds: float = 0.0


@dataclass
class SuiteRun:
    suite: str
    cases: list[CaseResult]
    summary: list[dict[str, Any]] = field(default_factory=list)
    experiment: str | None = None

    def metrics(self) -> dict[str, dict[str, float]]:
        """Mean and count per feedback key; a failed target counts in ``target_error``."""
        values: dict[str, list[float]] = {"target_error": []}
        for case in self.cases:
            values["target_error"].append(float(case.error is not None))
            for item in case.feedback:
                if item.get("score") is not None:
                    values.setdefault(item["key"], []).append(float(item["score"]))
        return {key: {"mean": sum(v) / len(v), "n": len(v)} for key, v in values.items() if v}


def _normalise(result: Any) -> list[dict[str, Any]]:
    if result is None:
        return []
    if isinstance(result, dict) and "results" in result:
        result = result["results"]
    return list(result) if isinstance(result, list) else [result]


async def apply_evaluator(evaluator: Callable, example: dict[str, Any], outputs: dict[str, Any]) -> list[dict]:
    available = {"inputs": example["inputs"], "outputs": outputs, "reference_outputs": example["outputs"]}
    wanted = [name for name in inspect.signature(evaluator).parameters if name in EVALUATOR_ARGS]
    try:
        result = evaluator(**{name: available[name] for name in wanted})
        if inspect.isawaitable(result):
            result = await result
        return _normalise(result)
    except Exception as error:
        return [{"key": getattr(evaluator, "__name__", "evaluator"), "score": None,
                 "comment": f"evaluator error: {type(error).__name__}: {error}"[:300]}]


def _summaries(suite: Suite, cases: list[CaseResult], examples: dict[str, dict]) -> list[dict[str, Any]]:
    done = [case for case in cases if case.outputs is not None]
    outputs = [case.outputs for case in done]
    references = [examples[case.case_id]["outputs"] for case in done]
    summary: list[dict[str, Any]] = []
    for evaluator in suite.summary_evaluators:
        summary += _normalise(evaluator(outputs=outputs, reference_outputs=references)) if done else []
    return summary


async def run_local(suite: Suite, examples: list[dict], *, concurrency: int, repetitions: int) -> SuiteRun:
    slots = asyncio.Semaphore(concurrency)

    async def one(example: dict) -> CaseResult:
        async with slots:
            case = CaseResult(case_id=example["metadata"]["case_id"], outputs=None)
            started = time.monotonic()
            try:
                case.outputs = await suite.target(example["inputs"])
            except Exception as error:
                case.error = f"{type(error).__name__}: {error}"[:500]
            case.seconds = time.monotonic() - started
            if case.outputs is not None:
                for evaluator in suite.evaluators:
                    case.feedback += await apply_evaluator(evaluator, example, case.outputs)
            return case

    cases = await asyncio.gather(*(one(example) for example in examples for _ in range(repetitions)))
    by_id = {example["metadata"]["case_id"]: example for example in examples}
    return SuiteRun(suite.name, list(cases), _summaries(suite, list(cases), by_id))


def sync_dataset(client, suite: Suite, examples: list[dict]) -> str:
    """Make the LangSmith dataset match the JSONL file, keyed by ``case_id``."""
    name = suite.dataset_name
    if not client.has_dataset(dataset_name=name):
        client.create_dataset(name, description=suite.description,
                              metadata={"source": "services/ai-service/evals/datasets", "suite": suite.name})
    existing = {example.metadata.get("case_id"): example for example in client.list_examples(dataset_name=name)}
    creates, updates = [], []
    for example in examples:
        current = existing.pop(example["metadata"]["case_id"], None)
        if current is None:
            creates.append(example)
        elif (current.inputs != example["inputs"] or (current.outputs or {}) != example["outputs"]
              or (current.metadata or {}).get("tags") != example["metadata"].get("tags")):
            updates.append({"id": current.id, **example})
    if creates:
        client.create_examples(dataset_name=name, examples=creates)
    if updates:
        client.update_examples(dataset_name=name, updates=updates)
    if existing:
        client.delete_examples([example.id for example in existing.values()])
    return name


async def run_langsmith(suite: Suite, examples: list[dict], client, *, concurrency: int, repetitions: int,
                        prefix: str, metadata: dict[str, Any]) -> SuiteRun:
    from langsmith import aevaluate

    dataset = sync_dataset(client, suite, examples)
    results = await aevaluate(
        suite.target, data=dataset, evaluators=suite.evaluators, summary_evaluators=suite.summary_evaluators,
        experiment_prefix=prefix, description=suite.description, metadata=metadata,
        max_concurrency=concurrency, num_repetitions=repetitions, client=client)
    cases = []
    async for row in results:
        run, example = row["run"], row["example"]
        feedback = [{"key": r.key, "score": r.score, "comment": r.comment or ""}
                    for r in row["evaluation_results"]["results"]]
        cases.append(CaseResult(case_id=(example.metadata or {}).get("case_id", str(example.id)),
                                outputs=run.outputs if not run.error else None, feedback=feedback,
                                error=run.error[:500] if run.error else None))
    by_id = {example["metadata"]["case_id"]: example for example in examples}
    return SuiteRun(suite.name, cases, _summaries(suite, cases, by_id), experiment=results.experiment_name)
