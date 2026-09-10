# Chat memory and @file references

Small Migration / Circini · Conversation decisions and application guide · 10 September 2026

## Release status

The full-history memory change is live: commit fe0fac0 passed its deployment workflow. The file library is recorded in commit 6db270274a7b36444611c405b7652ba61ba147e4, and all eight CI jobs passed. The feature deployment completed successfully, including schema synchronization, service health gates, the production smoke test and GitHub integration checks. The application release is live. Production acceptance tests passed for dummy files, exact versions, generated outputs, reuse of an existing owned uploaded file, semantic retrieval and user isolation. All seven browser interaction checks passed against the live application without API mocks, including preview/download, exact-version use, chat reload, resumed-chat references and a 390-pixel mobile layout.

Evidence: [successful memory deployment](https://github.com/shankasf/small_migration/actions/runs/34538569854), [file library commit](https://github.com/shankasf/small_migration/commit/6db270274a7b36444611c405b7652ba61ba147e4), [passed feature CI](https://github.com/shankasf/small_migration/actions/runs/34540309633), [successful feature deployment](https://github.com/shankasf/small_migration/actions/runs/34540309836).

Repository: [shankasf/small_migration](https://github.com/shankasf/small_migration), branch: main. Deployment was triggered directly from main through GitHub Actions; no pull request was created for this release. Code evidence links are pinned to feature commit 6db270274a7b36444611c405b7652ba61ba147e4; the memory fix is included in that release history.

## What we discussed and decided

1. **How each chat and user were remembered.** Chats and messages are stored in PostgreSQL and associated with a session and its owner. At the start of the discussion, the backend sent only the latest 20 messages to the AI. There was no independent memory of a user's preferences across every chat.
2. **What one hour and 50 sessions mean.** These settings bound temporary AI-service RAM caches. An inactive chat may lose its cached agent/files after an hour, and older caches are evicted when the tracked count exceeds 50. Saved database messages are not deleted by cache eviction. This is an application setting, not an industry-mandated number.
3. **The SDK capability and immediate memory fix.** The OpenAI Agents SDK can manage conversation history through a configured session. Compaction can reduce growing model context. The immediate authorized change removed the 20-message cutoff; it did not migrate this app to SDK-managed sessions or introduce a cross-chat preference profile.
4. **Deployment while continuing the discussion.** You requested the memory change be deployed by a separate agent so the discussion could continue. Later you explicitly requested that both the memory change and new file feature be live and tested.
5. **Reusing files from any of your chats.** We selected a My Files library with an @ entry point, covering uploaded files and chatbot-generated outputs. Results identify the filename, original chat, source type, date, and version.
6. **Search by meaning.** “Find the customer SQL I generated yesterday” should be able to find a file named stg_clients.sql. The key ideas are semantic matching, user isolation, and source/date filters.
7. **Storage and 1,000 files.** Files remain in PostgreSQL. Searchable content and embeddings live alongside the application data. Searching does not send the entire 1,000-file library into the chat model.
8. **A summary in the file table.** You proposed pgvector and a one-line summary on each file row. That is a valid lightweight design, but a short summary can omit a field or SQL condition.
9. **Why content chunks are also useful.** A summary saying “Customer SQL joining clients and addresses” might omit WHERE country = 'US'. Searching the actual chunks can find that detail. Keyword search handles exact terms such as country or customer_id; vector search handles related meanings such as customer and client.
10. **Avoiding conflicting versions.** Summaries and chunks must refer to the same immutable version. The complete stored content is the authority; a summary is a discovery aid. New content gets a new version instead of silently changing an old selection.
11. **Ensuring the correct file is used.** Search suggests candidates, and you preview/select a result. The backend resolves the selected stable ID and version and checks ownership. It does not choose between identical filenames by guessing.
12. **Industry evidence and approval to implement.** We checked official examples of explicit file context, hybrid search, pgvector, and document access controls. You authorized implementation, deployment, live tests using a dummy file and a resumed existing chat, and this Word explanation. You then asked that agents work in parallel to finish promptly.

This is a complete topic-by-topic explanation of the conversation and its decisions, rather than a verbatim transcript. Earlier suggestions are distinguished below from the behavior actually implemented.

## How memory works in this application

### Saved chat history

PostgreSQL stores each Message under its Session. The backend now loads the complete saved message list in chronological order on each turn, screens the message/history/files, and sends that history to the AI service. A restart or RAM eviction does not erase those saved messages.

For example, an instruction given 30 messages ago is no longer excluded by an application limit of 20 messages. The model still has a finite context window: loading full history is not unlimited memory, and sufficiently large conversations/files can exceed model limits. Automated compaction is a future improvement, not part of this change.

Evidence: [backend chat context](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/src/routes/chat.ts), [message/session schema](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/prisma/schema.prisma), [AI input and Runner call](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/ai-service/routes/migration.py).

### Temporary RAM caches

The AI service caches session agents, files, and activity timestamps in its own process. Cleanup checks remove entries after more than 3,600 seconds of inactivity and evict least recently accessed entries when the tracked count exceeds 50. Cleanup runs when session storage is accessed, so this is not a promise of deletion at the exact one-hour mark or an exact global count across replicas.

Example: leave chat A unused for 70 minutes. Its temporary cache can be cleared on a later cleanup. Opening or continuing chat A still loads its saved history and files from the database. If a process has too many cached chats, older caches make room; database chats remain.

Evidence: [SESSION_TTL_SECONDS, SESSION_MAX_COUNT and eviction](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/ai-service/routes/migration.py).

### User identity and retention

Sessions belong to an ownerUserId. Existing session permissions allow the owner and authorized administrators to access session data. My Files discovery and cross-chat attachment resolution are specifically restricted to the signed-in user's owned files. The library does not automatically expose another person's files to an administrator's personal picker.

Durable chats, uploads, outputs, usage and audit records retain the existing indefinite-retention policy. Authorized explicit deletion is separate from automatic cache eviction. Deleting a source file also deletes its library snapshots and chunks; references in other saved messages retain their filename/version labels with an unavailable asset. Deleting a source chat removes its assets through the session relationship. A deleted source cannot be recreated by a stale background backfill. No new automatic deletion is introduced by this work.

The app does not yet maintain an automatic cross-chat preference record such as “this user always wants Snowflake SQL.” File reuse across your chats is retrieval of selected files, not a hidden global conversation history.

Evidence: [authentication and access checks](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/src/middleware/auth.ts), [retention policy](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/src/services/retention.ts), [file ownership enforcement](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/src/services/fileLibrary.ts).

### OpenAI Agents SDK: capability versus adoption

The SDK supports configured sessions that load prior conversation items and persist new items. OpenAI also documents compaction for managing long context. These are available building blocks; they do not automatically implement this application's user ownership, file versions, or cross-chat preference memory.

This release continues the application's explicit history assembly and Runner.run_streamed call. It does not pass a new SDK session, activate automatic compaction, or create a user-memory profile. Those may be designed later while preserving the application's own durable records and access checks.

Sources: [official OpenAI documentation: running agents](https://developers.openai.com/api/docs/guides/agents/running-agents), [official OpenAI documentation: compaction](https://developers.openai.com/api/docs/guides/compaction).

## How @ works for you

1. Open a new chat or resume an existing chat. Type @ or use the My Files control to open the picker.
2. Search by filename, meaning, or a code detail. Narrow the list with Uploaded/Generated and date filters such as Yesterday.
3. Read the filename, version, source chat, timestamp, summary, and matching excerpt. Preview opens that exact saved version; Download retrieves it.
4. Select Use in this chat. The composer shows the selected file chip. Up to 10 files can be selected per message. Remove a chip before sending if it is the wrong choice.
5. Send your instruction, for example: “Update the selected customers.sql v3 using the selected mapping.csv.” Selecting the result supplies the identity; typing a filename alone is not an attachment.
6. The backend validates the selected IDs and ownership, stores durable references with your message, and makes the exact selected content available to the AI. Filename plus version and ID distinguish files that happen to share a name.
7. Reloading the chat retains the message's attachment references. Later turns in that chat restore previously referenced files after checking ownership again. Selecting a newer version of the same source file makes that selected version take precedence for the new turn.

When several matches appear, preview and select the intended one. An explicit selection needs no second approval step. In the picker search box, a phrase such as “find customer SQL I generated yesterday” is interpreted into customer meaning/keywords, generated source, a .sql filename filter and yesterday’s UTC date range. The explicit picker date/source filters can narrow or override the inferred values. A general conversational search tool invoked from an ordinary sent chat message is not part of this implementation.

Evidence: [composer](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/frontend/src/components/ChatInput.tsx), [My Files picker](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/frontend/src/components/FileLibraryPicker.tsx), [preview](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/frontend/src/components/LibraryFilePreview.tsx), [chat integration](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/src/routes/chat.ts).

## Where files and the search data live

| Record | What it stores | Why it exists |
| --- | --- | --- |
| UploadedFile / GeneratedOutput | Existing uploaded content and generated outputs | Preserves the original application storage flow |
| FileAsset | Immutable content, source ID/chat, filename, source type, version, content hash, summary, timestamp, indexing state | One exact version used consistently for search, preview and attachment |
| FileChunk | FileAsset ID, section position, section text, 1,536-dimensional pgvector embedding | Finds detailed content and meaning within that same version |
| FileReference | Message ID, selected asset ID, filename, version, source type/chat | Retains the file selection when a chat is reloaded |

File ownership is resolved through the source Session's ownerUserId, rather than trusting a user ID supplied by the browser. A filename is a label; the immutable asset ID identifies the selected content. Version numbering is scoped to source chat, source type and filename. Therefore two different chats can each have customers.sql v1, while their IDs remain distinct.

For spreadsheet uploads, the existing ingestion flow parses worksheets into extracted text before persistence. An immutable file version preserves that exact stored content, not the original Excel binary bytes. Preview, AI context and library download operate on the stored representation.

The implemented summary is a compact extract of the filename and first three nonempty lines, capped at 300 characters. It is not an AI-authored description of the entire file. The summary is included as a prefix when each chunk is embedded, rather than stored in a separate summary-vector column. Content chunks carry the details the extract omits; the full content remains stored unchanged in the snapshot.

Evidence: [file schema](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/prisma/schema.prisma), [snapshot, summary and chunk creation](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/src/services/fileLibrary.ts).

## How search selects candidates

New snapshots create chunks of up to 1,200 Unicode code points with 160 code points of overlap, keeping code across boundaries searchable. Each embedding request includes a filename prefix of up to 240 code units plus the short summary; this keeps chunk requests bounded while preserving complete original content in storage. A background worker screens content before embedding-provider egress, generates chunk embeddings, and records indexing status. The worker also discovers older uploaded/generated records in small batches. Historical content that was overwritten before immutable snapshots existed cannot be reconstructed by backfill; backfill captures surviving database records.

Natural-language cues for today/yesterday, generated/uploaded and SQL are converted into filters, and remaining search words are converted to an embedding. PostgreSQL combines filename/full-text keyword candidates with pgvector semantic candidates inside the authorized user's subset, then merges their ranks. Results contain one entry per immutable file version rather than one entry per matching chunk. The picker fetches 20 results at a time and offers Load more.

Example A: “customer” can match content mentioning “clients” because embeddings encode related meaning. Example B: unique_late_filter can match a condition near the end of a large SQL file even when the summary does not mention it. Example C: selecting Generated and Yesterday narrows the candidate set using metadata rather than relying only on meaning.

If embeddings are unavailable, keyword matches remain usable and the picker reports that meaning search is unavailable. Files that have not finished indexing are still eligible for keyword discovery. Search is a relevance aid, not a guarantee of a correct match; preview and explicit selection establish the final identity.

For 1,000 files, the library searches stored metadata/content/vectors and returns a small page of results. The chatbot does not receive the entire library. A chat turn receives that chat's normal uploaded-file context plus explicit selected and restored references, so accumulated attachments and full history still contribute to model context size. This implementation uses exact vector search within the allowed subset; large-library performance should be measured before choosing an approximate index or further tuning.

Evidence: [index worker and hybrid query](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/src/services/fileLibrary.ts), [embedding-service boundary](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/src/services/aiService.ts).

## Why this design was selected

The design follows established patterns, rather than a single universal standard. pgvector supports storing vectors in PostgreSQL and combining semantic retrieval with PostgreSQL full-text search. Microsoft documents hybrid retrieval and document-level access controls. Cursor documents explicit file context for agents. These sources support the approach; application-specific relevance and performance still need testing.

Sources: [pgvector: hybrid search](https://github.com/pgvector/pgvector#hybrid-search), [Microsoft: hybrid search](https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview), [Microsoft: document access control](https://learn.microsoft.com/en-us/azure/search/search-document-level-access-overview), [Cursor: prompting agents](https://cursor.com/docs/agent/prompting).

## Verification and release evidence

The database integration suite passes eleven tests using an isolated localhost migration_security_test database, actual PostgreSQL/pgvector queries, and a deterministic mock embedding service. It verifies immutable upload versions, concurrent generated versions, semantic and late-keyword matches, owner/date/source filtering, natural-language and exact-filename handling, large-file keyword retrieval, keyword fallback, invalid-reference rejection, reference persistence, legacy backfill, and source-deletion behavior. The mock validates retrieval plumbing without claiming to evaluate real-provider semantic quality. A separate AI-service suite passes 13 tests for internal authentication, invalid input, blocking sensitive content before provider calls, screened text, correct vector dimensions/order, and unavailable or unapproved provider configuration.

Evidence: [AI embedding boundary tests](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/ai-service/tests/test_file_search.py), [file library integration tests](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/services/backend/tests/fileLibrary.test.ts), [security test runner](https://github.com/shankasf/small_migration/blob/6db270274a7b36444611c405b7652ba61ba147e4/scripts/test-security.sh).

Production acceptance requested in this conversation: deploy the memory and file changes, pass CI/security and ECS health gates, create/upload a uniquely named dummy file, find it through My Files, preview/select its exact version, use it in a chat, resume an existing chat and reuse an existing file, then verify saved references after reload. The final release record must list actual outcomes, release commit, CI/deployment run and live evidence; a build or local test alone is insufficient.

Feature commit: 6db270274a7b36444611c405b7652ba61ba147e4. CI run 34540309633: all eight jobs passed. Deployment run 34540309836: successful. Schema synchronization exited 0 at 23:22:49 UTC; the smoke test passed at 23:31:27 UTC and GitHub integration checks passed at 23:32:43 UTC on 10 September 2026. Live dummy-file and resumed-chat acceptance workflow 34542141976: successful. Final AWS status workflow 34542688597 confirmed all three services healthy on release 6db2702. Browser interaction verification: all seven checks passed at 23:35:24 UTC on 10 September 2026 against the live application without mocks. Memory deployment run 34538569854 for fe0fac0 passed.


### Production acceptance results

The production workflow passed using the deployed services and real database/provider integration. The dummy file was library_probe_5115bcb9240a.sql. Its two upload versions contained different values, 731 and 842; explicitly selecting the older version made the AI read 731. Generated-output revisions remained immutable and a generated file was reused in a new chat. Reuse of an existing owned uploaded file also passed. A reference owned by another user was rejected with HTTP 403. The temporary verification API key was revoked and subsequently rejected with HTTP 401.

Database evidence confirmed pgvector 0.8.1, 71 embedded chunks and a successful semantic search. The recorded older upload asset was 933a775d-be87-4b44-a62c-8c095ae7e593 (v1); the newer was 03f0bd84-5a52-443c-a6cd-c31e49853d81 (v2). The reused existing uploaded asset was bbefe7ad-b1df-4e9d-b6b4-919226887b1b.

Evidence: [successful production file-library acceptance](https://github.com/shankasf/small_migration/actions/runs/34542141976), [final healthy AWS service status](https://github.com/shankasf/small_migration/actions/runs/34542688597). The browser evidence is recorded below.


### Browser acceptance results

A real Chrome session against the live application passed seven checks at 23:35:24 UTC on 10 September 2026, without mocked API responses: authenticated immutable-version identity; @ picker discovery of both versions; preview and download of exact revision 731; no horizontal overflow at a 390-pixel mobile width; exact asset-ID submission in a new chat with AI reading 731; unchanged attached/used chips and content after reload; and resuming the existing test chat without reattachment, with AI reading revision 842 and the reference surviving reload.

Evidence: [browser verification record](https://github.com/shankasf/small_migration/blob/main/docs/evidence/file-library/browser-evidence.json), [mobile My Files screenshot](https://github.com/shankasf/small_migration/blob/main/docs/evidence/file-library/my-files-mobile.png), [production API/database verification record](https://github.com/shankasf/small_migration/blob/main/docs/evidence/file-library/production-evidence.json). The evidence records contain synthetic test identifiers and no authentication secrets.

The separate temporary browser credential was revoked after the browser checks, and a subsequent live request returned HTTP 401. Evidence: [successful browser credential cleanup](https://github.com/shankasf/small_migration/actions/runs/34542847757).
