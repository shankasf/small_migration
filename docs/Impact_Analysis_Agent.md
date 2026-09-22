# Impact Analysis Agent

The existing migration chatbot is now the **Head Agent**. It retains SQL/dbt generation and file tools for ordinary migration requests. For impact, lineage, dependency, affected-column and related validation requests, it calls **Impact Analysis Agent** as an internal tool. Both use the deployment's `OPENAI_MODEL` (`gpt-6-astra`). There is no conversational handoff.

The specialist prompt lives in `services/ai-service/prompts/impact_analysis.md`. The confirmed operating rules extend evidence access to the selected connected sources and keep analysis read-only.

## Answer shape

The reply is rendered through the head without paraphrasing, from a structured `ImpactReport`: one `### N. <question>` block per question the user asked, in their order and their wording, then **Watch out** and a one-line **Gaps** when they carry real information. Incomplete inputs produce only the missing questions.

This replaced a fixed ten-section report (Readiness Check, Change Summary, Hard Evidence Used, Lineage Summary and so on) in which every finding also carried an Evidence-backed / Inferred / Unknown label. A practitioner review of a five-question analysis found the substance correct but the delivery unreadable: the agent had imposed its own section template instead of answering the questions asked, labelled every line, and repeated the same caveats in three places. Evidence is now cited inline (`models/customer_mart.sql:3`, `ref('stg_customers')`, commit SHA, run ID) and a hedge appears only where it changes what the user should do, once.

## Mandatory checks

The same review found two omissions that cost real money, so both prompts — the specialist's and the head's migration instructions — now carry them as checks to run on every analysis, reported only when they apply:

- **No single whole-project `dbt build`.** It rebuilds unrelated models, costs hours of warehouse time, and a failing test skips everything downstream of it, so the run reports an incomplete picture. The recommendation is the staged sequence `dbt compile --select <model>` → `dbt build --select <model>` → `dbt build --select <model>+ --defer --state <prod artifacts>` → `dbt build --select state:modified+` in CI.
- **Snowflake precision and scale.** Snowflake does not error when the target scale is smaller than the source scale; it silently rounds to the target, so rows land, row counts match and dollar amounts are wrong. Bare `NUMBER`/`DECIMAL`/`INT` means `NUMBER(38,0)` and drops every decimal place. The validation is a `SUM()`/`MIN`/`MAX`/sampled row-diff reconciliation — row counts cannot detect it.

`scripts/check-impact-agent-live.cjs` gates both against production: its synthetic manifest carries a `number(38,2)` money column narrowed to `number(38,0)` downstream, and the check asserts the truncation warning, a selective build plan, answers numbered in the order asked, and the absence of the old scaffolding.

## Source confirmation

Every new analysis begins with a source-selection question, even if the initial request already mentions a source. Replies can name sources (`Use uploads and GitHub`) or list numbers (`1 and 3`). `yes` alone does not grant access. Source switches and a new target/change require fresh confirmation; clarifications within the same analysis retain the selected scope.

Supported sources:

1. Uploaded files, explicitly attached versions and pasted references.
2. Earlier chats and saved files belonging to the same user.
3. GitHub repositories accessible to the user's connected GitHub App.
4. GitLab.com repositories accessible with the user's saved OAuth connection.
5. Existing run artifacts from the configured `cloud.getdbt.com` account.
6. Snowflake column and object-dependency metadata using fixed, parameterized SELECT statements.

Unavailable connections are identified; they are not silently replaced with another source. Ambiguous repositories/branches/runs/versions require clarification. Provider-specific access remains subject to the connected account's permissions.

`Session.impactState` holds the server-owned analysis ID, actor, request, source grant and timestamps. It survives service restarts and is retained with the chat. Only the actual authenticated user's explicit selection can populate the grant. Every internal evidence read checks the internal service credential, current user status, session ownership, analysis ID and selected source. Provider credentials never enter tool schemas or responses.

## Evidence and read-only boundaries

The specialist has one evidence-reading tool. It cannot access the head's generation tools, shell, arbitrary SQL, job execution, commits or writes. Snowflake access is metadata-only; proposed validation commands are recommendations and are never run by the specialist. Chat assertions are not treated as proof of a file or dependency.

Reference reads carry file versions/content hashes, repository commit SHAs or dbt run IDs. Large files are paginated. JSON artifacts support matching nodes and immediate parent/child IDs; the agent follows those IDs to trace deeper paths. Partial references, warehouse metadata latency, missing permissions and unsupported column lineage remain explicit gaps.

## Verification

`tests/impact.test.ts` exercises source parsing, authorization, provider read restrictions and artifact traversal. `services/ai-service/tests/test_impact_pipeline.py` runs the real LangGraph impact subgraph with scripted models to verify source confirmation (an `interrupt()` pause), grounded-evidence gating, answer order and no pre-confirmation reads; `evals/` scores the live agents in LangSmith. The production gate `scripts/verify-impact-agent-production.py` exercises the public chat API using a synthetic manifest and a temporary API key that is revoked afterward. Synthetic evidence/chat records are retained under the application's retention policy.

Provider readers are tested with mocked responses; a passing synthetic upload gate does not establish live access to every user's GitLab, dbt Cloud or Snowflake account.
