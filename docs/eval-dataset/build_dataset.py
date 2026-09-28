"""Build the offline regression evaluation dataset for the migration agent.

Reads the curated scenarios mined from the project's development history
(``mined_scenarios.json``) and, optionally, a redacted production chat corpus in
the same case schema, then writes:

  agent_eval_dataset.jsonl                     one full case per line (documentation fields + harness example)
  harness/<suite>.jsonl                        harness-shaped examples, loadable by services/ai-service/evals
  Agent_Offline_Regression_Eval_Dataset.docx   the reviewable document

    python docs/eval-dataset/build_dataset.py
    python docs/eval-dataset/build_dataset.py --prod-corpus path/to/cases.json
    python docs/eval-dataset/build_dataset.py --no-docx         # jsonl only

Needs python-docx for the document (pip install python-docx). Nothing here calls a model or a network.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import hashlib
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
EVALS = REPO / "services" / "ai-service" / "evals"
MINED = HERE / "mined_scenarios.json"
DEFAULT_PROD = Path("/tmp/claude-1000/-home-ubuntu-apps-small-migration/59a27615-96d5-4f42-a053-bab42b0a5c75/"
                    "scratchpad/prod_corpus/cases.json")
JSONL = HERE / "agent_eval_dataset.jsonl"
HARNESS_DIR = HERE / "harness"
DOCX = HERE / "Agent_Offline_Regression_Eval_Dataset.docx"

SUITES = ["router", "guard", "grant_judge", "generation", "impact", "history", "repository", "memory", "consult"]
CATEGORIES = ["routing", "injection guard", "history/file delivery", "impact analysis", "SQL/dbt model generation",
              "mapping interpretation", "GitHub/GitLab integration", "memory", "clarification-asking", "feedback"]
SEVERITIES = ["blocker", "major", "minor"]
REQUIRED = ["case_id", "category", "agent", "suite", "source", "turns", "input", "attached_files",
            "expected_behaviour", "reference_outputs", "evaluators", "severity", "regression_of", "harness"]

# The pipeline each harness suite exercises; used for the coverage matrix.
SUITE_AGENT = {
    "router": "Router Agent", "guard": "Injection Guard", "grant_judge": "Grant Judge",
    "generation": "Migration build (Analyst / Author / Reviewer)", "impact": "Impact (Investigator / Reporter)",
    "history": "History Agent", "repository": "Repository Agent", "memory": "Memory (Consultant / capture_memory)",
    "consult": "Migration Consultant",
}

# Evaluators each suite applies (services/ai-service/evals/suites.py), plus the dataset-extension evaluators
# run_offline.py adds when a case's reference carries their keys.
SUITE_EVALUATORS = {
    "router": ["route_correct", "route_accuracy (summary)"],
    "guard": ["guard_flag_correct", "guard_rates (summary)"],
    "grant_judge": ["grant_decision_correct"],
    "generation": ["generation_outcome", "no_active_content"],
    "impact": ["turn_expectations", "impact_report", "no_active_content", "report_groundedness", "impact_correctness"],
    "history": ["text_expectations", "tool_trajectory", "tool_policy", "delivered_files"],
    "repository": ["text_expectations", "tool_trajectory", "tool_policy"],
    "memory": ["text_expectations", "tool_trajectory", "tool_policy"],
    "consult": ["answer_correctness", "no_active_content"],
}
NATIVE_TEXT = {"history", "repository", "memory"}
EXTENSIONS = {  # reference key -> extension evaluator (see run_offline.py)
    "must_contain_any": "mentions_any", "expect_no_files": "no_unrequested_files", "max_files": "file_cap",
    "asks_clarification": "asks_clarification", "not_blocked": "not_blocked",
}

CATEGORY_SUITE = {  # default suite for prod-corpus cases that do not name one
    "routing": "router", "injection guard": "guard", "history/file delivery": "history",
    "impact analysis": "impact", "SQL/dbt model generation": "generation", "mapping interpretation": "consult",
    "GitHub/GitLab integration": "repository", "memory": "memory", "clarification-asking": "generation",
    "feedback": "consult",
}

# --- redaction ---------------------------------------------------------------------------------------------
# Same shapes the service's guardrails treat as PII/secrets (services/ai-service/guardrails.py), plus the names
# of real people seen in the development history. RFC 2606 example domains are synthetic and allowed.
_NHI = re.compile(r"\b[A-HJ-NP-Z]{3}(?:\d{4}|\d{2}[A-HJ-NP-Z]{2})\b")
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
_SECRETS = [re.compile(p) for p in (
    r"\bsk-[A-Za-z0-9_\-]{20,}\b", r"\bAKIA[0-9A-Z]{16}\b", r"\bASIA[0-9A-Z]{16}\b", r"\bABSK[A-Za-z0-9+/=_-]{20,}",
    r"\bgh[pousr]_[A-Za-z0-9]{30,}\b", r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}\b",
    r"\blsv2_[A-Za-z0-9_]{20,}\b", r"IQoJb3JpZ2lu[A-Za-z0-9+/=]{20,}", r"-----BEGIN [A-Z ]*PRIVATE KEY-----")]
# Real people's names never belong in the dataset. They are matched by hash so
# the guard itself does not publish them: any word whose lowercased SHA-256
# prefix is listed here is replaced (and fails the final check if it survives).
_NAME_HASHES = frozenset({
    "265719f4e7ee032f",
    "375aa95e781bad28",
    "8e74438d07347b3c",
    "a1c46e535844a931",
    "ae74f72d212fb987",
    "cc505d3f030573e2",
    "cd0b9452fc376fc4",
    "d51ae77904d69eb3",
})
_WORD = re.compile(r"[A-Za-z]+")


class _HashedNames:
    """Drop-in for the compiled name pattern: .search and .sub over words."""

    @staticmethod
    def _is_name(word: str) -> bool:
        return hashlib.sha256(word.lower().encode()).hexdigest()[:16] in _NAME_HASHES

    def search(self, text: str):
        return next((m for m in _WORD.finditer(text) if self._is_name(m.group(0))), None)

    def sub(self, replacement: str, text: str) -> str:
        return _WORD.sub(lambda m: replacement if self._is_name(m.group(0)) else m.group(0), text)


_NAMES = _HashedNames()
_ALLOWED_EMAIL_DOMAINS = {"example.com", "example.net", "example.org"}
# Placeholder synthetic values the dataset deliberately contains (a guardrail must strip or refuse them).
_ALLOWED_TOKENS = {"cedar-lantern-hollow-42"}


def redact_text(text: str) -> str:
    text = _EMAIL.sub(lambda m: m.group(0) if m.group(1).lower() in _ALLOWED_EMAIL_DOMAINS else "<email>", text)
    text = _NHI.sub("<nhi>", text)
    for pattern in _SECRETS:
        text = pattern.sub("<secret>", text)
    return _NAMES.sub("analyst", text)


def redact(value):
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    return value


def pii_findings(value, path="") -> list[str]:
    found = []
    if isinstance(value, str):
        for m in _EMAIL.finditer(value):
            if m.group(1).lower() not in _ALLOWED_EMAIL_DOMAINS:
                found.append(f"{path}: email")
        if _NHI.search(value):
            found.append(f"{path}: NHI-shaped {_NHI.search(value).group(0)}")
        if any(p.search(value) for p in _SECRETS):
            found.append(f"{path}: secret-shaped token")
        if _NAMES.search(value):
            found.append(f"{path}: person name {_NAMES.search(value).group(0)!r}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            found += pii_findings(v, f"{path}[{i}]")
    elif isinstance(value, dict):
        for k, v in value.items():
            found += pii_findings(v, f"{path}.{k}")
    return found


# --- derivation: documentation fields from the harness example -------------------------------------------

def _fixture_label(value) -> str:
    if isinstance(value, str) and value.startswith("@fixture:"):
        return f"evals/fixtures.py FIXTURES['{value.split(':', 1)[1]}']"
    size = len(value) if isinstance(value, str) else len(json.dumps(value))
    return f"inline synthetic content ({size} chars)"


def attached_files(suite: str, inputs: dict) -> list[dict]:
    files = []
    turns = inputs.get("turns") or [inputs]
    for number, turn in enumerate(turns, 1):
        for name, content in (turn.get("files") or {}).items():
            files.append({"name": name, "turn": number, "kind": "upload", "fixture": _fixture_label(content)})
    backend = inputs.get("backend") or {}
    for upload in backend.get("uploads") or []:
        files.append({"name": upload["filename"], "kind": "impact evidence upload", "fixture": _fixture_label(upload["content"])})
    if backend.get("github_repo"):
        repo = backend["github_repo"]
        files.append({"name": repo["full_name"], "kind": "GitHub repository snapshot",
                      "fixture": f"evals/repos/{repo['snapshot']} @ {repo['commit_sha'][:7]}"
                                 + (f"; blocked: {', '.join(repo.get('blocked_paths', []))}" if repo.get("blocked_paths") else "")})
    if (backend.get("github") or {}).get("file"):
        for path, content in backend["github"]["file"].get("files", {}).items():
            files.append({"name": path, "kind": "GitHub file (synthetic gateway)", "fixture": _fixture_label(content)})
    fetch = (backend.get("chat_search") or {}).get("fetch")
    for item in (fetch if isinstance(fetch, list) else [fetch] if fetch else []):
        files.append({"name": item["filename"], "kind": f"saved chat asset v{item.get('version', 1)} (delivery source)",
                      "fixture": _fixture_label(item.get("content", ""))})
    return files


def display_turns(suite: str, inputs: dict) -> tuple[list[dict], str]:
    """Prior history as {role, content} and the final user message."""
    if "turns" not in inputs:
        history = list(inputs.get("history") or [])
        if suite == "grant_judge":
            history = [{"role": "system", "content": f"[confirmed analysis] {inputs['confirmed_request']} "
                                                      f"(sources: {', '.join(inputs.get('sources') or ['uploads'])})"}] + history
        if inputs.get("pending"):
            history.append({"role": "system", "content": f"[pending {inputs['pending'].get('kind')}] {inputs['pending'].get('question')}"})
        if inputs.get("pending_question"):
            history.append({"role": "system", "content": f"[pending question] {inputs['pending_question']}"})
        return history, inputs["message"]
    turns = inputs["turns"]
    history = list(turns[0].get("history") or [])
    for number, turn in enumerate(turns[:-1], 1):
        history.append({"role": "user", "content": turn["message"]})
        history.append({"role": "assistant", "content": f"<live reply to turn {number}, replayed by the harness>"})
    last = turns[-1]
    if len(turns) > 1 and last.get("history"):
        history += [h for h in last["history"] if h.get("content") not in ("@previous_response",) and
                    not str(h.get("content", "")).startswith("@response:")]
    return history, last["message"]


def evaluators_for(suite: str, outputs: dict) -> list[str]:
    names = list(SUITE_EVALUATORS[suite])
    if suite not in NATIVE_TEXT and (outputs.get("must_contain") or outputs.get("must_not_contain")):
        names.append("text_expectations (extension)")
    names += [f"{EXTENSIONS[key]} (extension)" for key in EXTENSIONS if key in outputs]
    return names


def build_case(raw: dict, origin: str) -> dict:
    suite = raw["suite"]
    inputs, outputs = raw["inputs"], raw["outputs"]
    turns, final = display_turns(suite, inputs)
    tags = sorted(set(raw.get("tags") or []) | {raw["category"].replace("/", "-").replace(" ", "-"), raw["severity"], origin})
    return {
        "case_id": raw["case_id"],
        "category": raw["category"],
        "agent": raw["agent"],
        "suite": suite,
        "source": raw["source"],
        "turns": turns,
        "input": final,
        "attached_files": raw.get("attached_files") or attached_files(suite, inputs),
        "expected_behaviour": raw["expected_behaviour"],
        "reference_outputs": outputs,
        "evaluators": raw.get("evaluators") or evaluators_for(suite, outputs),
        "severity": raw["severity"],
        "regression_of": raw["regression_of"],
        "harness": {"suite": suite, "example": {
            "inputs": inputs, "outputs": outputs,
            "metadata": {"case_id": raw["case_id"], "tags": tags, "category": raw["category"],
                         "severity": raw["severity"], "regression_of": raw["regression_of"]}}},
    }


# --- production corpus ingestion ---------------------------------------------------------------------------

def _prod_harness(case: dict) -> tuple[str, dict, dict] | None:
    """Harness inputs/outputs for a prod case that did not carry them; None when it cannot run offline."""
    suite = case.get("suite") or CATEGORY_SUITE.get(case.get("category"), "consult")
    if case.get("harness"):
        h = case["harness"]
        example = h.get("example") or h
        return h.get("suite", suite), example["inputs"], example["outputs"]
    ref = dict(case.get("reference_outputs") or {})
    history = [t for t in case.get("turns") or [] if t.get("role") in ("user", "assistant")]
    files = {f["name"]: f["content"] for f in case.get("attached_files") or [] if isinstance(f, dict) and f.get("content")}
    if suite == "router":
        route = ref.get("route") or ref.get("expected_route")
        if not route:
            return None
        return suite, {"message": case["input"], "history": history, **({"files": files} if files else {})}, {"route": route}
    if suite == "guard":
        if "flagged" not in ref:
            return None
        return suite, {"message": case["input"], "history": history}, {"flagged": bool(ref["flagged"])}
    if suite == "grant_judge":
        return None
    turn = {"message": case["input"], "history": history, **({"files": files} if files else {})}
    outputs = {k: v for k, v in ref.items() if k not in ("route", "expected_route")}
    if suite == "generation":
        if ref.get("asks_clarification"):
            outputs["expect"] = "clarification"
        elif isinstance(ref.get("files"), dict):
            outputs["expect"] = "files"
        elif "expect" not in outputs:
            return None
    if suite == "consult" and not outputs.get("reference_answer"):
        return None
    if suite == "impact" and not ({"required", "checks", "questions"} <= set(outputs) or outputs.get("expect") == "missing_input"):
        return None
    return suite, {"backend": {}, "turns": [turn]}, outputs


def load_prod(path: Path) -> tuple[list[dict], list[str]]:
    data = json.loads(path.read_text())
    records = data.get("cases", data) if isinstance(data, dict) else data
    out, notes = [], []
    for record in records:
        record = redact(record)
        cid = str(record.get("case_id") or f"case-{len(out) + 1}")
        cid = cid if cid.startswith("prod-") else f"prod-{cid}"
        built = _prod_harness(record)
        if built is None:
            notes.append(f"{cid}: kept for review but not harness-runnable (reference lacks machine-checkable keys)")
            suite = record.get("suite") or CATEGORY_SUITE.get(record.get("category"), "consult")
            harness = None
        else:
            suite, inputs, outputs = built
            harness = {"inputs": inputs, "outputs": outputs}
        src = record.get("source")
        raw = {
            "case_id": cid, "category": record.get("category", "feedback"), "agent": record.get("agent", SUITE_AGENT[suite]),
            "suite": suite, "source": src if isinstance(src, dict) else {"kind": "production", "session": str(src or "")},
            "expected_behaviour": record.get("expected_behaviour", ""), "severity": record.get("severity", "major"),
            "regression_of": record.get("regression_of", "production feedback"), "tags": ["production"],
            "inputs": (harness or {}).get("inputs") or {"turns": [{"message": record.get("input", "")}]},
            "outputs": (harness or {}).get("outputs") or record.get("reference_outputs") or {},
            "attached_files": [{k: v for k, v in f.items() if k != "content"} for f in record.get("attached_files") or []
                               if isinstance(f, dict)] or None,
        }
        case = build_case(raw, "production")
        if record.get("turns"):
            case["turns"] = record["turns"]
        if record.get("input"):
            case["input"] = record["input"]
        if harness is None:
            case["harness"] = {"suite": suite, "example": None, "offline_runnable": False}
        out.append(case)
    return out, notes


# --- validation --------------------------------------------------------------------------------------------

def validate(cases: list[dict]) -> list[str]:
    errors = []
    ids = Counter(c["case_id"] for c in cases)
    errors += [f"duplicate case_id {cid}" for cid, n in ids.items() if n > 1]
    fingerprints = Counter(json.dumps(c["harness"]["example"]["inputs"], sort_keys=True)
                           for c in cases if c["harness"].get("example"))
    errors += ["duplicate inputs across cases" for _, n in fingerprints.items() if n > 1]
    for c in cases:
        cid = c["case_id"]
        errors += [f"{cid}: missing {k}" for k in REQUIRED if k not in c or c[k] in (None, "") and k != "attached_files"]
        if c["suite"] not in SUITES:
            errors.append(f"{cid}: unknown suite {c['suite']}")
        if c["category"] not in CATEGORIES:
            errors.append(f"{cid}: unknown category {c['category']}")
        if c["severity"] not in SEVERITIES:
            errors.append(f"{cid}: unknown severity {c['severity']}")
        example = c["harness"].get("example")
        if example is None:
            continue
        i, o = example["inputs"], example["outputs"]
        s = c["suite"]
        if s in ("router", "guard") and not isinstance(i.get("message"), str):
            errors.append(f"{cid}: {s} needs inputs.message")
        if s == "router" and o.get("route") not in ("generate", "consult", "repository", "history", "impact", "out_of_scope", "blocked"):
            errors.append(f"{cid}: bad route {o.get('route')}")
        if s == "guard" and not isinstance(o.get("flagged"), bool):
            errors.append(f"{cid}: guard needs outputs.flagged")
        if s == "grant_judge" and not (i.get("confirmed_request") and i.get("message") and isinstance(o.get("continues"), bool)):
            errors.append(f"{cid}: grant_judge needs confirmed_request, message, continues")
        if s in ("generation", "impact", "history", "repository", "memory", "consult"):
            if not (isinstance(i.get("turns"), list) and i["turns"] and all(isinstance(t.get("message"), str) for t in i["turns"])):
                errors.append(f"{cid}: conversation suite needs inputs.turns[*].message")
        if s == "generation":
            if o.get("expect") not in ("files", "clarification"):
                errors.append(f"{cid}: generation expect must be files|clarification")
            if o.get("expect") == "files" and not (isinstance(o.get("files"), dict) and all(o["files"].values())):
                errors.append(f"{cid}: generation files must map filename -> non-empty field list")
            for pattern in o.get("sql_must_match", []):
                try:
                    re.compile(pattern)
                except re.error as err:
                    errors.append(f"{cid}: bad regex {pattern!r}: {err}")
        if s == "impact" and o.get("expect") != "missing_input":
            for key in ("turns", "required", "questions", "checks"):
                if key not in o:
                    errors.append(f"{cid}: impact needs outputs.{key}")
            for name, pattern in (o.get("checks") or {}).items():
                try:
                    re.compile(pattern)
                except re.error as err:
                    errors.append(f"{cid}: bad check {name}: {err}")
        if s == "consult" and not o.get("reference_answer"):
            errors.append(f"{cid}: consult needs reference_answer")
        for finding in pii_findings(c):
            errors.append(f"{cid}: PII/secret {finding}")
    return errors


# --- document ------------------------------------------------------------------------------------------------

def write_docx(cases: list[dict], path: Path, notes: list[str], prod_path: Path | None) -> None:
    """Render the reviewable document; layout lives in docx_layout.py."""
    sys.path.insert(0, str(HERE))
    import docx_layout

    docx_layout.write(
        cases, path, suites=SUITES, categories=CATEGORIES, suite_agent=SUITE_AGENT,
        thresholds=json.loads((EVALS / "thresholds.json").read_text()), notes=notes,
        prod_present=bool(prod_path and prod_path.exists()), sources_text=DOC_TEXT)


# Prose for the document, kept here with the dataset it describes.
DOC_TEXT = {
    "sources": [
        "Claude Code session transcripts for this project (30 sessions and their subagent transcripts, 2026-09-03 to "
        "2026-09-27): user bug reports, pasted production conversations, production investigations, eval runs and "
        "the fixes that followed.",
        "Fix commits on main (for example 659e28a, 9a68840, ac92c10, 757e53a, 34788c5, 10142c0, 1508d14, 6d1fc25, "
        "1199e16, cffa760, 2620575, 616f5e7), whose messages record the failure and the intended behaviour.",
        "The existing eval suite in services/ai-service/evals (datasets, suites.py, evaluators.py, harness.py, "
        "fixtures.py, thresholds.json) and the agent roster in docs/LangGraph_Agent_Architecture.md.",
        "Project memory notes: GitHub App access model, file hand-over, long-term memory, production-check fixtures.",
    ],
    "no_prod": "A redacted production chat corpus was not available when this document was generated; rebuild with "
               "--prod-corpus to fold it in (cases are prefixed prod-).",
    "relationship": "The harness already holds 99 synthetic cases across nine suites. These cases extend them without "
                    "duplicating them: case ids are unique across both sets and no case repeats an existing case's "
                    "inputs. Where a production incident is already covered (for example the Losartan impact replay), "
                    "the cases here target the specific failure modes found along the way (placeholder ids, line-label "
                    "ids, snapshot stages, answers with gaps) rather than the scenario as a whole.",
    "gaps": [
        "Draft capture: the 2026-09-23 'give me the model sql' failure was traced in production to the author "
        "returning no usable SQL draft on all three attempts (output 2,972 / 1,589 / 560 tokens of a 16k cap; input "
        "about 20k of 128k), not to a context or output limit. It is fixed in 616f5e7 and guarded by "
        "enrolment-give-me-the-model-sql. The model's reply form varies run to run, so a single pass is weak "
        "evidence; run that case with --repetitions 4.",
        "Template syntax: the static validator (services/ai-service/validation.py) accepts only literal "
        "ref/source/config Jinja, so '{{ target.name }}' and '{% if %}' are always rejected. An environment-dependent "
        "rule must be written without them; pii-rule-without-jinja-target guards this.",
        "Output-limit truncation is guarded by wide-mapping-output-cap. If it fails, check the model.author activity "
        "rows for stopReason max_tokens.",
        "Model-side transport faults seen in production (control tokens in tool names, 'Invalid JSON when parsing "
        "model output', invented tool names) cannot be forced from a dataset; they are covered only by "
        "target_error = 0 across every case and by the service's unit tests.",
        "Cross-chat memory recall cannot be replayed: the harness runs one thread per case, so memory cases check "
        "same-chat recall and the guard, not a second chat (the production memory check covers that).",
        "Health-PII blocking (an NHI in a message) is not included, to keep NHI-shaped values out of the dataset; it "
        "is covered by the service's guardrail unit tests.",
        "GitLab, dbt Cloud and Snowflake metadata sources have no synthetic gateway yet, so only their 'not "
        "connected' and grant behaviour is covered.",
        "Extension-evaluator thresholds are proposals; calibrate them over repeated live runs before gating CI on "
        "them.",
    ],
}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mined", type=Path, default=MINED)
    parser.add_argument("--prod-corpus", type=Path, default=DEFAULT_PROD,
                        help="optional redacted production cases.json (same case schema); skipped if absent")
    parser.add_argument("--no-docx", action="store_true")
    args = parser.parse_args(argv)

    mined = json.loads(args.mined.read_text())
    cases = [build_case(raw, "transcript") for raw in mined["cases"]]
    notes: list[str] = []
    if args.prod_corpus and args.prod_corpus.exists():
        prod, notes = load_prod(args.prod_corpus)
        taken = {c["case_id"] for c in cases}
        cases += [p for p in prod if p["case_id"] not in taken]
        print(f"production corpus: {len(prod)} cases from {args.prod_corpus}")
    else:
        print("production corpus: not present, skipped")

    # Existing harness case ids must not be reused (the runner can merge both sets).
    existing = {json.loads(line)["metadata"]["case_id"] for f in (EVALS / "datasets").glob("*.jsonl")
                for line in f.read_text().splitlines() if line.strip()}
    errors = [f"{c['case_id']}: collides with an existing harness case id" for c in cases if c["case_id"] in existing]
    errors += validate(cases)
    if errors:
        print("dataset invalid:\n  " + "\n  ".join(errors), file=sys.stderr)
        return 1

    order = {s: i for i, s in enumerate(SUITES)}
    cases.sort(key=lambda c: (order[c["suite"]], c["case_id"].startswith("prod-")))
    JSONL.write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in cases))
    HARNESS_DIR.mkdir(exist_ok=True)
    for suite in SUITES:
        examples = [c["harness"]["example"] for c in cases if c["suite"] == suite and c["harness"].get("example")]
        (HARNESS_DIR / f"{suite}.jsonl").write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in examples))
    if not args.no_docx:
        write_docx(cases, DOCX, notes, args.prod_corpus)
    print(f"{len(cases)} cases -> {JSONL.relative_to(REPO)}; harness/*.jsonl"
          + ("" if args.no_docx else f"; {DOCX.relative_to(REPO)}"))
    for key, counter in (("suite", Counter(c["suite"] for c in cases)), ("category", Counter(c["category"] for c in cases)),
                         ("severity", Counter(c["severity"] for c in cases))):
        print(f"  by {key}: " + ", ".join(f"{k}={v}" for k, v in counter.most_common()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
