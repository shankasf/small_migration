# LangGraph agent architecture

The AI service runs its agents on LangGraph (`services/ai-service/workflow/`). The OpenAI Agents SDK is
gone. The HTTP contract with the backend (`POST /ai/chat` and the rest) is unchanged.

The design follows LangGraph's "Thinking in LangGraph" method:

1. Map the work into discrete steps.
2. Classify each step as an LLM, data, action or user-input step.
3. Keep raw facts in state and format prompts inside nodes.
4. Handle each error type in its own way.
5. Wire the nodes together.

## One turn, one run; one chat, one thread

```
START → screen_input ─┬→ route_intent ──────┬→ policy_gate ─→ [grant_judge] → dispatch → <specialist> → capture_memory → screen_output → END
         │            ├→ injection_guard ───┤      │ flagged → END                          │
         │            ├→ recall_memories ───┤                                               │
         │            └→ summarize_history ─┘                                               │
         │ blocked → END                                                                    │
         └──────────────────── ← rerun (a paused question was answered) ───────────────────┘
```

- Each chat session is a LangGraph thread (`thread_id` = session id). Checkpoints live in DynamoDB.
- A turn's request content (message, files, history, identity, backend gateway, logger) travels in the
  runtime context. It is never written to a checkpoint.
- Checkpoints hold only screened workflow facts: pending questions, the analyst's specification, and
  generated drafts for later revisions.
- `workflow/orchestrator.py` builds the graph. Specialists are registered against a route
  (`SpecialistRegistry`), so adding one does not touch the orchestration.

## The agents and their steps

| Agent (LLM step) | Model role | Data / action / user-input steps around it |
|---|---|---|
| Router Agent | `router` | `screen_input` (action), `dispatch` (data) |
| Injection Guard | `guard` | runs in parallel with the router; `policy_gate` (action) blocks a flagged turn |
| Grant Judge | `grant_judge` | re-checks that a confirmed evidence grant covers this turn |
| History Agent | `history` | `search_chat_history`, `search_chat_files`, `request_file_delivery` (data); `delivery_gate` / `locate_file` (data), `deliver_files` (action) |
| Repository Agent | `repository` | four read-only GitHub tools (data) |
| Migration Consultant | `consultant` | `list_files`, `get_file_content` (data); `remember`, `forget` (action: long-term memory) |
| Requirements Analyst | `analyst` | GitHub tools (data); `clarify` (user input: `interrupt()`) |
| Model Author ×N | `author` | fan-out with `Send`, one per target model; `validate` (data: sqlglot static checks) |
| Model Reviewer | `reviewer` | the 12-point checklist; defects loop back to the author (at most 2 revisions); `publish` (action) |
| Evidence Investigator | `investigator` | `read_impact_evidence` (data, line-numbered file reads); `plan_sources` / `ask_sources` and `ask_user` (user input: `interrupt()`); `evidence_gate` (data) |
| Impact Reporter | `reporter` | `finish` (action); a data change reported without `dbt seed` is sent back once |
| Summarizer | `summarizer` | `summarize_history`: condenses a long chat's older turns (LLM step, only past the threshold) |
| Memory capture | `summarizer` | `capture_memory`: records a standing instruction the turn did not save (LLM step, only when asked) |

**Tool-using agents** (`workflow/agents/base.py`) are built from LangGraph primitives: a model node, a
`ToolNode` and conditional edges.

- The loops compile with `checkpointer=False`, so large tool transcripts are never persisted.
- GPT-OSS on Bedrock cannot be forced to call a tool. Agents that must return a typed result therefore
  submit it through a `submit_<schema>` tool:
  - a malformed submission comes back as a validation error the model can fix;
  - a model that keeps answering in prose is nudged;
  - if nudging fails, one structured-output call records the prose as the result.

## History pipeline details

- **Naming a file is not giving it.** The LLM step may only ask for a delivery, by the asset id a search
  returned; `deliver_files` is the action step that fetches the content and attaches it to the reply as a
  downloadable file. The content never enters the model's context or the activity log.
- **The hand-over does not depend on the model.** Asked for a file, GPT-OSS answers with its name and
  source chat instead of calling `request_file_delivery` (observed in production and over repeated eval
  runs). `delivery_gate` therefore detects the request deterministically, and `locate_file` resolves the
  filename in the answer to exactly one asset the user owns. None or several matches deliver nothing.
- **The user's own files only.** The backend resolves the id with the same ownership rule as an @ mention
  (`resolveFileRefs`), refuses anything else, and audits the hand-over as `chat.file.attach`.
- **Bounded.** At most three files per reply, each capped at 400 KB, screened outbound like any generated
  file. A delivery that fails is stated in the reply rather than dropped.

## Impact pipeline details

- **Evidence is read, not summarised away.** Every file the investigator reads is kept verbatim for the
  turn (per-turn workspace, never checkpointed) and handed to the reporter, which checks each claim and
  line number against it. File content arrives labelled `L12| …`; the label is not data.
- **Coverage before questions.** The dossier maps each of the user's questions to the evidence that answers
  it. Anything still open, or anything the investigator was about to ask the user for, sends it back once
  to read what a confirmed source already holds (for example a seed CSV for "which rows are affected").
  Only what no confirmed source contains becomes a question, and that question is a paused user-input step.
- **Change kind drives the build plan.** The dossier records whether the change edits model SQL or seed/
  source data; a seed change must be reported as `dbt seed` → landing → `dbt snapshot` → downstream (or one
  `dbt build --select <seed>+`).
- **Replies to a pending question return to it.** The router treats an answer to a pending clarification or
  impact question as that pipeline's input; whether it keeps the evidence grant is the Grant Judge's call,
  which sees the confirmed sources and the question. Naming a repository or branch inside a confirmed
  source continues the analysis; adding a new source category needs fresh confirmation.

## Error handling by type

| Error | Handling |
|---|---|
| Transient (throttling, 5xx, timeouts) | `RetryPolicy` on every LLM node (`workflow/resilience.py`), plus the boto/OpenAI client retries |
| LLM-recoverable (bad JSON, invalid tool arguments, failed static validation, reviewer defects, an investigator that read nothing) | Loop back to the model with the error. Static validation gives the author the specific reason. |
| User-fixable (missing base model, unclear mapping, unconfirmed evidence sources) | `interrupt()`. The next message resumes the thread and is screened and routed again, so a change of topic is never captured by the pause. |
| Unexpected | Bubbles up. The route logs a content-free `turn.failed` record (exception type, provider code, file:line frames) and returns HTTP 500. |

## Guardrail layers

These map LangChain's guardrails guide (before agent, around tools, human in the loop, after agent) onto
LangGraph nodes. See `workflow/security.py`.

1. **Before agent, deterministic: `screen_input`.**
   - Checks: injection and deny-list patterns, NZ health PII (blocked), PII and secrets (redacted),
     encoded obfuscation, size limits, history roles.
   - Nothing reaches a model before this node.
2. **Before agent, model-based: Injection Guard and `policy_gate`.**
   - Catches paraphrased prompt extraction, instruction overrides, confirmation bypass, exfiltration
     requests and instructions hidden in uploaded files.
   - Fails closed.
3. **Around tools.**
   - Every backend payload is screened like an upload before a model reads it.
   - `ToolNode(awrap_tool_call=guard_tool_call)` redacts and size-caps every tool result.
   - Each agent sees only its own tools, and every tool is read-only.
   - Identity comes from the turn context, never from tool arguments.
4. **Human in the loop.**
   - Evidence sources are read only after the user confirms them.
   - The backend owns and re-checks the grant.
5. **After agent: `screen_output`.**
   - Redacts PII and secrets.
   - Removes auto-loading images and HTML, an exfiltration channel.
   - Refuses replies containing the system-prompt canary.

Every system prompt ends with shared security rules (`prompts/security.md`).

## Memory

LangGraph's two halves, both wired as the docs prescribe: a checkpointer for the thread, a store for
what outlives it.

| Horizon | Where | What it holds | Lifetime |
|---|---|---|---|
| This turn | `TurnContext` / `TurnWorkspace` (runtime context) | message, attached files, conversation, recalled memories | the run |
| This chat | DynamoDB checkpoint, `thread_id` = session id | pending question, analyst spec and drafts, impact work, last route, running summary | 30-day TTL |
| This user | DynamoDB store, namespace `("memories", user_id)` | standing instructions the user asked to be remembered | **no expiry** |

**Short-term: a chat that never outgrows the window.** The backend re-sends the saved conversation every
turn. `summarize_history` keeps the newest `SUMMARY_KEEP_CHARS` verbatim and folds everything older into a
running summary held in state, advancing `summarized_upto` so later turns reuse it instead of paying for it
again. The verbatim window is fixed and the summary is rewritten rather than appended to, so a chat can run
for years at constant prompt size. The summary is derived data: if the thread's checkpoint has expired, the
next long turn rebuilds it, and a conversation shorter than the summary covers resets it.

**Long-term: memory that accumulates for the life of the account.** `remember` and `forget` (Migration
Consultant) and the `capture_memory` step write only what the user asked to be remembered — never file contents, tool results or the
agent's own conclusions, and never secrets or PII, which the outbound guardrail strips before the write.
Each fact is keyed by its subject, so restating or changing a standing instruction replaces it instead of
leaving two contradictory rows. The write does not depend on the model choosing to call a tool: when a
message plainly asks for something to be remembered and the turn saved nothing, `capture_memory` reads that
message — only the user's own words — and records one instruction or decides there was nothing durable in
it. Over repeated live runs the agent answered "I'll keep that in mind" and called nothing often enough
that a promise this plain could not rest on it. `recall_memories` reads at most `MEMORY_RECALL_LIMIT` items by nearest
neighbour over the store's vector index, so recall costs the same at twenty memories and at twenty years of
them, and a store outage degrades to no memory rather than a failed turn. `GET`/`DELETE /ai/memory/{user}`
expose and erase everything held for one person.

## Persistence

- **Store:** `DynamoDBStore` from `langgraph-checkpoint-aws`, table `circini-agent-memory`, no TTL, vector
  index built on the same embedding provider as chat search. The stack owns the table; the service only adds
  the vector index if it is missing, and runs without semantic recall if that is unavailable.
- **Saver:** `DynamoDBSaver` from `langgraph-checkpoint-aws`, table `circini-agent-checkpoints`. Checkpoints
  larger than 350 KB offload to the S3 bucket `circini-agent-checkpoints-<account>-<region>`.
- **Expiry:** DynamoDB TTL and the S3 lifecycle both expire items after 30 days.
- **Write volume:** `durability="exit"` writes one checkpoint per turn.
- **Deserialisation:** runs against LangGraph's allow-list (`LANGGRAPH_STRICT_MSGPACK=true`).
- **Access:** the AI service's task role (`circini-ai-service-task`) can reach only that table and bucket.
  It holds no database credentials.
- **Deletion:** `/ai/reset/{session}` deletes the thread.

## Memory

- The LangGraph stack loads in about 100 MB.
- Each compiled agent costs about 40 KB, so the number of agents is not what limits memory.
- Memory grows with the turns in flight, each holding its screened files:
  - `MAX_CONCURRENT_TURNS=4` makes further turns wait for a slot;
  - `MAX_PARALLEL_TASKS=3` caps the author/reviewer fan-out.
- Measured locally: about 104 MB idle and about 250 MB with four concurrent generation flows. The
  container has 2 GB.

## Tracing and evaluation

- **Trace export:**
  - Traces go to LangSmith only through an explicit callback, whose client anonymises content with the
    guardrail recognisers plus LangSmith's secret detectors.
  - Environment-level `LANGSMITH_TRACING` is refused at startup.
  - Export turns on when `circini/langsmith-api-key` exists: the deploy converges it from the
    `LANGSMITH_API_KEY` GitHub secret.
  - The organisation is in LangSmith's US region.
- **Evaluation:** `services/ai-service/evals/` holds synthetic datasets per agent, code and LLM-as-judge
  evaluators (judge: GPT-OSS 120B) and thresholds. The suite runs nightly, and before every deploy as a
  gate. See `docs/Agent_Evals.md`.

## Testing

```
cd services/ai-service
pip install -r requirements-dev.txt
python -m pytest tests/          # graph, pipelines, guardrails, gateway, DynamoDB checkpointer (moto)
python -m evals.run --gate       # live agents vs thresholds (needs Bedrock + optional LangSmith keys)
```

After each deploy, the production gates run against the live site:

- `verify-impact-agent-production.py`
- `verify-chat-search-production.py`
- `verify-agent-graph-production.py`: generation with a clarification pause, resume, a reviewed file, and
  metering.
