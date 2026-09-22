"""Run the agent evaluation suites.

    python -m evals.run                       # every suite; LangSmith if LANGSMITH_API_KEY is set
    python -m evals.run --suite router,guard  # selected suites
    python -m evals.run --gate                # exit 1 when a threshold in evals/thresholds.json fails
    python -m evals.run --no-upload           # local only: nothing is sent to LangSmith
    python -m evals.run --case policies-clear # one case, for debugging

Models run on Bedrock (GPT-OSS 120B), configured the same way as the service.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from evals import env

env.prepare()

from evals.harness import SuiteRun, run_langsmith, run_local  # noqa: E402
from evals.suites import SUITES  # noqa: E402

THRESHOLDS = Path(__file__).resolve().parent / "thresholds.json"


def git_sha() -> str:
    sha = os.environ.get("GITHUB_SHA")
    if not sha:
        try:
            sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            sha = "local"
    return sha[:7]


def check(run: SuiteRun, thresholds: dict) -> list[str]:
    failures = []
    metrics = run.metrics()
    for key, rule in {**thresholds.get("*", {}), **thresholds.get(run.suite, {})}.items():
        if key not in metrics:
            continue
        value = metrics[key]["mean"]
        if "min" in rule and value < rule["min"]:
            failures.append(f"{run.suite}.{key} = {value:.3f} < {rule['min']}")
        if "max" in rule and value > rule["max"]:
            failures.append(f"{run.suite}.{key} = {value:.3f} > {rule['max']}")
    return failures


def show(run: SuiteRun, thresholds: dict) -> None:
    rules = {**thresholds.get("*", {}), **thresholds.get(run.suite, {})}
    print(f"\n== {run.suite}" + (f"  (experiment: {run.experiment})" if run.experiment else "  (local)"))
    for key, value in sorted(run.metrics().items()):
        rule = rules.get(key, {})
        bound = f">= {rule['min']}" if "min" in rule else f"<= {rule['max']}" if "max" in rule else ""
        print(f"   {key:<28} {value['mean']:.3f}  (n={value['n']:<3}) {bound}")
    for item in run.summary:
        if item.get("score") is not None:
            print(f"   [summary] {item['key']:<24} {item['score']:.3f}")
    lower_is_better = {key for key, rule in rules.items() if "max" in rule}
    for case in run.cases:
        if case.error:
            print(f"   ! {case.case_id}: target error: {case.error}")
        for item in case.feedback:
            score = item.get("score")
            if score is not None and (score > 0 if item["key"] in lower_is_better else score < 1):
                print(f"   - {case.case_id}: {item['key']}={score:.2f} {item.get('comment', '')[:220]}")
    tokens = [(c.outputs or {}).get("input_tokens", 0) + (c.outputs or {}).get("output_tokens", 0) for c in run.cases]
    if any(tokens):
        print(f"   tokens (agents): {sum(tokens):,}")


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--suite", default="all", help=f"all or a comma list of: {', '.join(SUITES)}")
    parser.add_argument("--case", action="append", default=[], help="run only these case_ids")
    parser.add_argument("--gate", action="store_true", help="exit 1 when a threshold fails")
    parser.add_argument("--upload", dest="upload", action="store_true", default=None)
    parser.add_argument("--no-upload", dest="upload", action="store_false")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--report", help="write per-case results to this JSON file")
    args = parser.parse_args(argv)

    from llm import configure_llm
    configure_llm()  # the same provider approvals as the service

    names = list(SUITES) if args.suite == "all" else [n.strip() for n in args.suite.split(",") if n.strip()]
    unknown = [n for n in names if n not in SUITES]
    if unknown:
        parser.error(f"unknown suite(s): {unknown}")
    upload = bool(os.environ.get("LANGSMITH_API_KEY")) if args.upload is None else args.upload
    if upload and not os.environ.get("LANGSMITH_API_KEY"):
        parser.error("--upload needs LANGSMITH_API_KEY")
    thresholds = json.loads(THRESHOLDS.read_text())
    client = None
    if upload:
        from langsmith import Client
        client = Client(api_key=os.environ["LANGSMITH_API_KEY"],
                        api_url=os.environ.get("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com").rstrip("/"))
    from evals.targets import registry
    sha = git_sha()
    metadata = {"git_sha": sha, "agent_framework": "langgraph", "provider": registry().provider_name,
                "models": registry().model_name, "judge": registry().model_name}

    runs: list[SuiteRun] = []
    for name in names:
        suite = SUITES[name]
        examples = [e for e in suite.examples() if not args.case or e["metadata"]["case_id"] in args.case]
        if not examples:
            continue
        if client is not None and not args.case:
            run = await run_langsmith(suite, examples, client, concurrency=args.concurrency,
                                      repetitions=args.repetitions, prefix=f"{name}-{sha}",
                                      metadata={**metadata, "suite": name})
        else:
            run = await run_local(suite, examples, concurrency=args.concurrency, repetitions=args.repetitions)
        show(run, thresholds)
        runs.append(run)
    if client is not None:
        client.flush()

    if args.report:
        Path(args.report).write_text(json.dumps([{
            "suite": run.suite, "experiment": run.experiment, "metrics": run.metrics(), "summary": run.summary,
            "cases": [{"case_id": c.case_id, "error": c.error, "feedback": c.feedback, "seconds": round(c.seconds, 1),
                       "response": (c.outputs or {}).get("response")} for c in run.cases]} for run in runs], indent=1))
    failures = [failure for run in runs for failure in check(run, thresholds)]
    print("\nGate: " + ("PASSED" if not failures else "FAILED\n   " + "\n   ".join(failures)))
    return 1 if (args.gate and failures) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
