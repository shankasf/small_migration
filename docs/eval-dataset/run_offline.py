"""Run the regression dataset through the stock eval harness, offline.

    cd services/ai-service
    python ../../docs/eval-dataset/run_offline.py --list
    python ../../docs/eval-dataset/run_offline.py --gate --repetitions 2
    python ../../docs/eval-dataset/run_offline.py --suite generation --case enrolment-give-me-the-model-sql
    python ../../docs/eval-dataset/run_offline.py --with-existing --gate --repetitions 2

What it does, without modifying anything under services/:
  * points evals.suites at docs/eval-dataset/harness/<suite>.jsonl (merged with evals/datasets with --with-existing);
  * adds the dataset-extension evaluators below to a suite only for cases whose reference carries their key;
  * merges their proposed thresholds into evals/thresholds.json for this run;
  * calls evals.run.main with --no-upload unless --upload is given, so nothing is sent to LangSmith.

The agents still call the model under test (Bedrock GPT-OSS 120B): set AWS_BEARER_TOKEN_BEDROCK.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent.parent / "services" / "ai-service"
HARNESS = HERE / "harness"
sys.path.insert(0, str(SERVICE))

from evals import env  # noqa: E402

env.prepare()

import evals.run as run  # noqa: E402
import evals.suites as suites  # noqa: E402
from evals import evaluators as ev  # noqa: E402

# Proposed gates for the extension keys (uncalibrated; see the dataset document, section 4).
EXTRA_THRESHOLDS = {
    "generation": {"mentions_required": {"min": 0.9}, "avoids_forbidden": {"min": 1.0}},
    "impact": {"mentions_required": {"min": 0.9}, "avoids_forbidden": {"min": 1.0}},
    "consult": {"mentions_required": {"min": 0.9}, "avoids_forbidden": {"min": 1.0}},
    "*": {"mentions_any": {"min": 0.75}, "no_unrequested_files": {"min": 1.0}, "file_cap": {"min": 1.0},
          "asks_clarification": {"min": 0.9}, "not_blocked": {"min": 1.0}},
}


# --- extension evaluators (LangSmith convention: return None-scored feedback when not applicable) --------

def text_expectations_if_set(outputs: dict, reference_outputs: dict):
    if not (reference_outputs.get("must_contain") or reference_outputs.get("must_not_contain")):
        return []
    return ev.text_expectations(outputs, reference_outputs)


def mentions_any(outputs: dict, reference_outputs: dict):
    groups = reference_outputs.get("must_contain_any")
    if not groups:
        return []
    text = (outputs.get("response") or "").lower()
    return [ev.feedback("mentions_any", any(alt.lower() in text for alt in group), f"needs one of {group}")
            for group in groups]


def no_unrequested_files(outputs: dict, reference_outputs: dict):
    if not reference_outputs.get("expect_no_files"):
        return []
    files = list((outputs.get("files") or {}))
    return [ev.feedback("no_unrequested_files", not files, f"attached {files}")]


def file_cap(outputs: dict, reference_outputs: dict):
    cap = reference_outputs.get("max_files")
    if cap is None:
        return []
    files = list((outputs.get("files") or {}))
    return [ev.feedback("file_cap", 0 < len(files) <= cap, f"attached {len(files)}: {files}, cap {cap}")]


def asks_clarification(outputs: dict, reference_outputs: dict):
    if "asks_clarification" not in reference_outputs:
        return []
    asked = ev.asks_user(outputs.get("response") or "")
    return [ev.feedback("asks_clarification", asked == bool(reference_outputs["asks_clarification"]), f"asked={asked}")]


def not_blocked(outputs: dict, reference_outputs: dict):
    if not reference_outputs.get("not_blocked"):
        return []
    blocked = [n for n, turn in enumerate(outputs.get("turns") or [], 1) if turn.get("guardrail") == "blocked"]
    return [ev.feedback("not_blocked", not blocked, f"blocked turns {blocked}")]


CONVERSATION = {"generation", "impact", "history", "repository", "memory", "consult"}
NATIVE_TEXT = {"history", "repository", "memory"}


def _read(path: Path) -> list[str]:
    return [line for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def prepare(with_existing: bool) -> Path:
    merged = Path(tempfile.mkdtemp(prefix="eval-dataset-"))
    for name in suites.SUITES:
        lines = _read(HARNESS / f"{name}.jsonl")
        if with_existing:
            lines = _read(suites.DATASET_DIR / f"{name}.jsonl") + lines
        (merged / f"{name}.jsonl").write_text("\n".join(lines) + ("\n" if lines else ""))
    suites.DATASET_DIR = merged  # Suite.examples() reads this module global at call time

    for name, suite in list(suites.SUITES.items()):
        extra = [mentions_any, no_unrequested_files, file_cap, asks_clarification, not_blocked]
        if name in CONVERSATION and name not in NATIVE_TEXT:
            extra.insert(0, text_expectations_if_set)
        if name not in CONVERSATION:
            extra = []  # single-step targets return no reply text or files
        suites.SUITES[name] = dataclasses.replace(suite, evaluators=[*suite.evaluators, *extra])

    thresholds = json.loads(run.THRESHOLDS.read_text())
    for suite, rules in EXTRA_THRESHOLDS.items():
        thresholds[suite] = {**rules, **thresholds.get(suite, {})}
    merged_thresholds = merged / "thresholds.json"
    merged_thresholds.write_text(json.dumps(thresholds, indent=1))
    run.THRESHOLDS = merged_thresholds
    return merged


def main(argv: list[str]) -> int:
    with_existing = "--with-existing" in argv
    argv = [a for a in argv if a != "--with-existing"]
    merged = prepare(with_existing)
    if "--list" in argv:
        for name, suite in suites.SUITES.items():
            ids = [e["metadata"]["case_id"] for e in suite.examples()]
            print(f"{name:<12} {len(ids):>3}  {', '.join(ids)}")
        print(f"(datasets: {merged})")
        return 0
    if "--upload" not in argv and "--no-upload" not in argv:
        argv = [*argv, "--no-upload"]
    return asyncio.run(run.main(argv))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
