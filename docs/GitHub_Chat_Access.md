# Connected GitHub access from chat

## Confirmed production problem

A read-only production diagnosis on September 11, 2026 resolved the supplied typo `sagar@callpshewre.ai` to the sole matching account, `sagar@callsphere.ai`. In chat `31737df6-3f53-4fb1-8222-1b3409d4a4a7`, the user asked “can you access my github” at September 10, 23:44:38 UTC. The assistant replied that it had no direct GitHub access at 23:44:40 UTC.

The account's GitHub connection was stored as connected, login `shankasf`, with repository `shankasf/small_migration` and branch `Feature-Review` selected. The associated turn had no tool calls. The missing capability was the chatbot's GitHub tool integration; the existing Settings connection alone did not provide repository tools to the agent.

Evidence: [read-only diagnostic run 34546503492](https://github.com/shankasf/small_migration/actions/runs/34546503492), diagnostic commit `99856cf` on the isolated `diagnostic/github-chat-sagar-20260911` branch. The database reads ran inside `SET TRANSACTION READ ONLY`; provider credentials were not selected or printed.

## Implemented behavior

The agent now has four read-only tools: `github_connection_status`, `list_github_repositories`, `list_github_files`, and `read_github_file`. When asked about access, it checks the connection instead of returning a generic upload-only answer. If connected, it discovers and reads actual repository files. If disconnected or access is revoked, it reports that condition and directs the user to Settings → Integrations.

The saved repository and selected branch are used unless the user chooses another accessible repository or ref. Tree/file reads resolve the branch to a commit SHA and read against that immutable commit. Results include repository, path, and commit provenance. Tree pages contain at most 500 entries and explicitly report additional pages or provider truncation. Files must be UTF-8 text no larger than 200 KB.

These tools cannot edit GitHub, commit, push, create pull requests, or change the saved repository selection. Generated downloads continue through the existing application output flow.

## Access and data boundaries

The backend sends the authenticated actor's connection metadata to the AI service. Actor and session IDs are supplied by server context, not model tool arguments. The internal gateway requires the shared internal service key and rechecks the actor's active status and permission to access the chat on every call.

The gateway always reads the current actor's own GitHub connection. An administrator viewing another user's chat does not inherit that user's GitHub credentials. Installation and repository access are checked again at read time, so stale metadata cannot grant access after revocation. Provider access and refresh tokens remain encrypted in the backend and never enter model context or tool schemas.

Retrieved repository content crosses the same guardrail policy boundary as uploads before reaching the model or tool-result logs. Injection and prohibited health data are blocked; secrets and applicable personal information are redacted. Repository text is treated as source data, not authority to change the user's task.

Code evidence:

- [Authenticated internal gateway and actor isolation](../services/backend/src/routes/githubAgent.ts)
- [Actual GitHub reads, permission checks, selected branch and commit pinning](../services/backend/src/services/githubAgent.ts)
- [Backend-owned chat context](../services/backend/src/routes/chat.ts)
- [AI function tools and retrieved-content screening](../services/ai-service/github_tools.py)
- [Agent registration and capability instructions](../services/ai-service/routes/migration.py)

## Verification and release gate

Local verification covers internal authentication, ownership/admin isolation, disconnected/revoked connections, foreign repositories, branch selection, commit pinning, pagination, path traversal, file size and absence of write operations. AI tests cover hidden actor/session context, fresh actor identity on cached tools, missing connections, secret redaction, injection blocking and actual registration of all four tools.

- [Backend regression tests](../services/backend/tests/githubAgent.test.ts)
- [AI regression tests](../services/ai-service/tests/test_github_tools.py)
- [Live end-to-end test](../scripts/check-github-agent-live.cjs)
- [OIDC/ECS verification runner](../scripts/verify-github-agent-production.py)

After the backend and AI service release reaches steady state, run `python3 scripts/verify-github-agent-production.py` from a GitHub Actions job using the existing production OIDC deployment identity. Set `GITHUB_VERIFY_EMAIL` to the exact active administrator account; it defaults to the account verified above. The runner creates a clearly labeled application verification chat and preserves the original user conversation. An optional `GITHUB_VERIFY_SESSION_ID` can resume only an existing chat belonging to that user whose name starts with `E2E GitHub read verification`.

The live test first reproduces the exact question “can you access my github” without naming tools, requires a real connection-status tool call and rejects the original generic denial. It verifies actual selected-repository reads and then requires all four GitHub tools to appear in real chatbot activity, checks the selected branch and commit provenance, and validates a concrete package name when reading package.json. GitHub files and connection selection are unchanged. A temporary application API key is revoked on completion or failure; no provider tokens or raw repository content are printed. The dedicated GitHub agent production E2E workflow exits nonzero and reports failure explicitly if verification fails.

A passing local build/test is not a production verification claim. Attach the successful release and live verification run to the final delivery record.
