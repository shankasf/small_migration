# Circini API / Swagger

[OpenAPI definition](./openapi.yaml) · [Swagger UI source](./index.html)

This definition documents **28 operations**, including chat, all agents and pipelines,
the 12 reusable agent tools, key management, uploads and downloads.

The deployed interactive viewer is available at
**https://migration-agent.uat.signify.net.nz/api-docs/**. Select **Current application**
and authorize with an API key. Browser requests use the same origin as the app.

## Open Swagger UI

From the repository root:

```bash
python3 -m http.server 8085 --bind 127.0.0.1 --directory docs/api
```

Open **http://127.0.0.1:8085**. The viewer loads pinned Swagger UI 5.32.15 assets
from unpkg and the local OpenAPI file. External online validation is disabled;
credentials are not persisted across page reloads.

You can also import `openapi.yaml` into your own Swagger UI or Postman.

For browser **Try it out** against a local backend, start that backend with
`CORS_ORIGIN=http://127.0.0.1:8085`, then select **Local backend** in Swagger's
Servers menu. For production, use the hosted viewer above, or curl/Postman.
A local preview does not change production CORS. Browser CORS
failures do not mean an API key is invalid.

## API-key authentication

1. Sign in to the app as an admin and open **Settings → API Keys**.
2. Create a key and save the complete `cmk_…` value; it is shown only once.
3. In Swagger **Authorize → ApiKeyBearer**, paste the key alone. Swagger adds
   `Authorization: Bearer` automatically.

```http
Authorization: Bearer <your-api-key>
```

Keys act as their admin owner and retain the owner's admin access on ordinary
session endpoints. The file library is more restrictive: it only searches and
attaches the current owner's files, including for admins.

Expiration options are 30, 90, 180 or 365 days (default 90), with at most 10
unrevoked, unexpired keys per owner. A revoked/expired key, disabled owner,
non-admin owner, or an owner access change invalidating the key prevents use.
Restricted accounts cannot perform normal write operations.

### Creating, listing and revoking keys

`GET /api/api-keys`, `POST /api/api-keys`, and `DELETE /api/api-keys/{keyId}`
require **AdminSession**, a signed-in admin session token. An API key cannot
manage API keys and receives `403`. Production uses the app's SSO login; the
local password-login endpoint is not a production token-issuance flow.

```json
{
  "name": "GitHub migration automation",
  "expiresInDays": 90
}
```

Creating a key returns `201` with `{ "key": { ...metadata }, "secret": "..." }`.
Listing keys returns metadata only. Revocation returns `204` without a body.
No real credentials are included in this repository.

## Example: use a key from a terminal

Set `CIRCINI_API_KEY` in your local environment or a GitHub Actions secret named
`CIRCINI_API_KEY`. The following commands use that variable rather than a key
committed to a file. Do not enable shell tracing when using it.

```bash
curl --fail-with-body 'https://migration-agent.uat.signify.net.nz/api/auth/me' \
  -H "Authorization: Bearer ${CIRCINI_API_KEY}"

curl --fail-with-body 'https://migration-agent.uat.signify.net.nz/api/sessions' \
  -H "Authorization: Bearer ${CIRCINI_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"name":"API migration test"}'
```

Use the returned session `id` in `CIRCINI_SESSION_ID`:

```bash
curl --fail-with-body \
  "https://migration-agent.uat.signify.net.nz/api/files/${CIRCINI_SESSION_ID}/upload" \
  -H "Authorization: Bearer ${CIRCINI_API_KEY}" \
  -F 'files=@samples/example.sql'

curl --fail-with-body --get \
  'https://migration-agent.uat.signify.net.nz/api/files/library' \
  -H "Authorization: Bearer ${CIRCINI_API_KEY}" \
  --data-urlencode 'q=example.sql'
```

Replace `samples/example.sql` with a file that exists on your computer. From the
search response, choose the intended file's immutable **asset ID**, then send:

```json
{
  "message": "Read the selected SQL and explain its purpose.",
  "fileRefs": ["00000000-0000-4000-8000-000000000001"]
}
```

POST this body to `/api/chat/{sessionId}/messages`; replace the illustrative UUID
with the actual asset ID. `fileRefs` accepts up to 10 library asset IDs, not
UploadedFile or GeneratedOutput IDs. Preview through
`GET /api/files/library/{assetId}/content` before choosing among versions.
Chat requests wait for the AI turn to finish. If a response is lost, inspect the
saved messages before retrying, since a turn may already have been processed.

## Agents and direct tools

- `GET /api/agents`: all agents and pipelines, their responsibilities and tool names.
- `GET /api/tools`: all reusable tools, their JSON argument schemas, agent mappings and prerequisites.
- `GET /api/agents/{agentId}/tools`: one agent's tools.
- `POST /api/tools/{toolName}/execute`: run that actual tool without a model call.

Create a session with `POST /api/sessions`, then use its ID:

```json
{"sessionId":"<your-session-id>","arguments":{}}
```

Send this to `/api/tools/list_files/execute`. Use the exact returned file label in
`arguments.file_name` for `get_file_content`. Both accept optional `fileRefs`
from the file library. To search past chats, call
`/api/tools/search_chat_history/execute` with
`arguments: {"query":"mapping","scope":"all","offset":0}`.

Tools cover attached files, saved-chat/file search, file delivery, GitHub reads,
confirmed impact evidence and user memory. GitHub reads require the caller's
connection. Impact evidence requires source confirmation through chat first.
`remember` and `forget` require `confirm: true` and change only the caller's
standing instructions. File delivery returns an authenticated `downloadUrl`;
it does not create a chat message. Direct calls never append chat history.
Check `ok` even after HTTP 200, since tool errors return `ok: false`.

Execution requires an active admin/analyst and an owned session, including for
admins. Runtime identity and source grants cannot be supplied by callers.
The catalogue is capability discovery, not proof that a particular integration
is connected. SQL authoring/review, generated-output publishing and structured
model responses remain coordinated by the chat workflow.

## Source and format references

- [API-key routes](../../services/backend/src/routes/apiKeys.ts)
- [API-key status and limits](../../services/backend/src/services/apiKeys.ts)
- [Authentication and role checks](../../services/backend/src/middleware/auth.ts)
- [Sessions](../../services/backend/src/routes/sessions.ts), [chat](../../services/backend/src/routes/chat.ts), [uploads/downloads](../../services/backend/src/routes/files.ts), [file library](../../services/backend/src/routes/fileLibrary.ts)
- [Swagger bearer authentication](https://swagger.io/docs/specification/v3_0/authentication/bearer-authentication/)
- [Swagger UI installation](https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/)
