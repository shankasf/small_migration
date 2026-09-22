# Agent evaluations (LangSmith)

The LangGraph agents in `services/ai-service` are evaluated with LangSmith against
live GPT-OSS 120B on Bedrock. Every dataset is synthetic (no customer data, names,
emails or health identifiers) and lives in `services/ai-service/evals/datasets/`.

## Suites

| Suite | What runs | What is measured |
|---|---|---|
| `router` (26) | Router Agent, after the real intake guardrails | route per turn; `new_analysis` for impact turns (pending questions, follow-ups, new targets) |
| `guard` (31) | Intake rules + model-based Injection Guard | attacks caught (`attack_caught`, recall) and benign-but-forceful migration requests passed (`false_positive`) |
| `grant_judge` (10) | Grant Judge | does a message continue the analysis whose sources were confirmed |
| `generation` (3) | Whole turns: analyst → clarify pause → authors → static validation → reviewer → publish | expected file delivered, every mapped field present, SQL passes static validation, rule checks (ref model, filter), asks instead of guessing when the mapping is ambiguous or the base model is missing |
| `impact` (2) | Whole conversation: source question, a vague "yes", confirmation, investigator, reporter | source question first, evidence actually read, required assets named, answers in the user's order, no audit scaffolding, mandatory checks (truncation, staged build), lineage groundedness (LLM judge) |
| `history` (3) | History Agent via the turn graph, synthetic chat search | exact filename recalled, no invented filenames, `search_chat_history` used (openevals trajectory match), never GitHub |
| `repository` (2) | Repository Agent, synthetic GitHub | repo/path/commit cited, access verified with tools, disconnected state explained |
| `consult` (4) | Migration Consultant | answer correctness against a reference (openevals `CORRECTNESS_PROMPT`, GPT-OSS judge) |

The graph, agents, prompts and guardrails are the production ones. The backend is
replaced by an in-process gateway (`evals/gateway.py`) that serves each case's data
through the same data-policy screening, so nothing reaches the real backend.

## Running

From `services/ai-service`, with the Bedrock key in the environment
(`AWS_BEARER_TOKEN_BEDROCK`) and `pip install -r requirements-dev.txt`:

```bash
python -m evals.run                          # all suites; uploads to LangSmith when LANGSMITH_API_KEY is set
python -m evals.run --suite router,guard     # selected suites
python -m evals.run --gate                   # exit 1 when evals/thresholds.json fails
python -m evals.run --no-upload              # local only, nothing sent to LangSmith
python -m evals.run --suite impact --case rename-customer-id --repetitions 4   # debug one case
RUN_AGENT_EVALS=1 python -m pytest evals/test_agent_evals.py -v               # pytest + LangSmith variant
```

`LANGSMITH_ENDPOINT` defaults to `https://api.smith.langchain.com` (the org is in the
US region). Datasets are synced idempotently by `case_id` into `circini-<suite>`
datasets; each run is an experiment named `<suite>-<git sha>-<suffix>` with the model,
provider and commit in its metadata. Local runs apply the same evaluators in-process.

## CI

`.github/workflows/agent-evals.yml` runs nightly (02:41 NZST), on demand, and as a
reusable workflow (`workflow_call`). It assumes the deploy role through OIDC only to
read `circini/bedrock-api-key`, masks it, runs `python -m evals.run --gate`, and
uploads `evals-report.json` as an artifact. Results appear in LangSmith under the
`circini-*` datasets (Datasets & Experiments → compare experiments for regressions).

## Thresholds

`evals/thresholds.json` holds the gate. Rates over many cases are set at what the
agents achieve today; single-scenario checks that mirror the production release
checks stay at 1.0. The file's `_notes` list the known misses at calibration.
Raise a threshold when a fix lands; never lower one to make a regression pass.


## Production-feedback cases

`impact` replays a real support conversation against `evals/repos/pharma_dbt` — a snapshot of the
synthetic dbt test project (seed → landing → snapshot → staging → reporting): the Losartan cost change
traced through `rep_dispensing`, in three variants (saved repository; choosing between two repositories;
a wrong source first, then "use the integrated dbt repository in github"). Each is scored against a
reference answer written from the fixture's actual lines, plus checks for `file:line` citations, the
affected prescription ids, and the seed → snapshot build order. `guard` and `grant_judge` carry the same
conversation's replies ("#3 github repositories", "3", "<repo> using the main branch") as benign and
continuing cases.
