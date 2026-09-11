# API keys

API keys let scripts, tools and other systems call the Circini REST API without
signing in through the browser.

| | |
|---|---|
| Base URL | `https://migration-agent.uat.signify.net.nz/api` |
| How to send the key | `Authorization: Bearer <key>` header on every request |
| Key format | `cmk_` followed by 43 characters |
| Who can create keys | Admins only, from **Settings → API keys** |

## 1. Scope: what a key can do

A key **acts as the admin who created it**. Every request is checked as that
admin, so a key has exactly the admin's access and never more.

| Area | With an API key |
|---|---|
| Account (`/api/auth/me`) | ✅ See who the key acts as |
| Chat sessions, for every user | ✅ List, read, create, rename, delete |
| Chat messages | ✅ Send and read. AI replies count toward the admin's token budget |
| Uploaded files and generated outputs | ✅ Upload, list, read, download, delete, validate |
| Integrations (GitHub, GitLab, Snowflake, dbt) | ✅ The key owner's own connections only. OAuth connections still finish in a browser |
| User management | ✅ List and create users, change role, status and token limits, revoke access |
| Usage, audit log, AI activity logs, security summary | ✅ Read |
| Live logs over WebSocket (`/api/socket.io`) | ✅ Same rooms the admin can join |
| Managing API keys (`/api/api-keys`) | ❌ `403`. Keys can only be managed from a signed-in browser session, so a leaked key cannot create more keys |
| Voice transcription (`/api/stt`) | ❌ `403` for everyone until voice is approved |
| Internal service routes (`/api/logs/...`, the AI service) | ❌ Not reachable with a key |

These rules apply to every request made with a key, exactly as in the app:

- **Content screening.** Prompts and uploads are screened. Blocked content
  returns `422` and is not stored.
- **Token budgets.** Usage is recorded against the admin. Once their daily or
  monthly limit is reached, chat returns `429`.
- **Audit.** Every change made with a key is recorded in the audit log with
  `type: api_key`. Creating and revoking keys is audited too.
- **Browsers.** The API only accepts browser requests from
  `https://migration-agent.uat.signify.net.nz`. Keys work from scripts, servers and API
  tools, not from web pages on other sites.

## 2. When a key stops working

| Status in Settings | Meaning |
|---|---|
| **Active** | The key works |
| **Inactive** | The owner's access changed after the key was created |
| **Expired** | The expiry date has passed |
| **Revoked** | An admin revoked it |

A key stops working immediately when:

- its expiry passes. You choose 30, 90, 180 or 365 days when creating it;
  there is no "never expires" option;
- any admin revokes it (every admin sees every key);
- its owner is demoted, disabled, has their role or status changed, has their
  password reset, or has their access revoked. Editing only other fields, such
  as token limits, leaves keys working.

With single sign-on, removing someone from the Cognito `admin` group takes
effect the next time they use the app. To cut a key off immediately, revoke the
key or use **Revoke access** for that user in the admin page.

Each admin can have up to 10 active keys. "Last used" updates at most once a
minute.

## 3. Create or revoke a key

1. Sign in at https://migration-agent.uat.signify.net.nz as an admin.
2. Open **Settings → API keys**.
3. Enter a name (for example the device or system that will use it), choose an
   expiry and click **Create key**.
4. Click **Copy key** and store it in a password manager or secret store. It is
   shown only once; afterwards only a hash is kept, so nobody can view it again.
5. To revoke, click **Revoke** next to the key and confirm.

## 4. Use the key on each device

Load the key into a variable instead of typing it into a command, so it does not
end up in shell history, logs or screenshots.

### Windows (PowerShell)

Open **Windows PowerShell** and run one line at a time:

```powershell
# Load the key without showing it; paste it at the prompt
$s = Read-Host "API key" -AsSecureString; $k = [Net.NetworkCredential]::new('', $s).Password
$h = @{ Authorization = "Bearer $k" }

# Quick check: prints 200 if the key works
curl.exe -s -o NUL -w "%{http_code}`n" -H "Authorization: Bearer $k" https://migration-agent.uat.signify.net.nz/api/auth/me

# Get data as PowerShell objects
Invoke-RestMethod https://migration-agent.uat.signify.net.nz/api/auth/me -Headers $h
$r = Invoke-RestMethod "https://migration-agent.uat.signify.net.nz/api/sessions?limit=5" -Headers $h
$r.sessions | Select-Object name, updatedAt

# Clear the key when finished
Remove-Variable k, s, h
```

- Type `curl.exe`, not `curl`. In Windows PowerShell, `curl` is a different
  command.
- Commands written for macOS/Linux, such as `read -rs` or `&&`, do not work in
  Windows PowerShell.
- For scheduled scripts, keep the key in an encrypted local vault:

  ```powershell
  Install-Module Microsoft.PowerShell.SecretManagement, Microsoft.PowerShell.SecretStore -Scope CurrentUser
  Register-SecretVault -Name LocalStore -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault
  Set-Secret -Name CIRCINI_API_KEY              # prompts for the key
  $k = Get-Secret -Name CIRCINI_API_KEY -AsPlainText
  ```

### macOS and Linux (Terminal)

```bash
# Load the key without showing it; paste it and press Enter
read -rs CIRCINI_API_KEY && export CIRCINI_API_KEY

# Quick check: prints 200 if the key works
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $CIRCINI_API_KEY" \
  https://migration-agent.uat.signify.net.nz/api/auth/me

# Five sessions, name and date only (needs jq)
curl -s -H "Authorization: Bearer $CIRCINI_API_KEY" \
  "https://migration-agent.uat.signify.net.nz/api/sessions?limit=5" | jq '.sessions[] | {name, updatedAt}'

# Clear the key when finished
unset CIRCINI_API_KEY
```

To keep the key for later on macOS, use the Keychain:

```bash
security add-generic-password -a "$USER" -s circini-api-key -w      # prompts for the key
export CIRCINI_API_KEY="$(security find-generic-password -a "$USER" -s circini-api-key -w)"
```

On Linux desktops, `secret-tool` does the same
(`secret-tool store --label="Circini API key" service circini-api-key`, then
`secret-tool lookup service circini-api-key`). On servers, use the platform's
secret manager or a file only the service user can read (`chmod 600`).

### Python

```python
import os
import requests

BASE = "https://migration-agent.uat.signify.net.nz/api"
HEADERS = {"Authorization": f"Bearer {os.environ['CIRCINI_API_KEY']}"}

me = requests.get(f"{BASE}/auth/me", headers=HEADERS, timeout=30)
me.raise_for_status()
print("Acting as", me.json()["email"])

session = requests.post(f"{BASE}/sessions", headers=HEADERS, json={"name": "API run"}, timeout=30)
session.raise_for_status()
session_id = session.json()["id"]

with open("mapping.csv", "rb") as f:
    upload = requests.post(f"{BASE}/files/{session_id}/upload", headers=HEADERS,
                           files=[("files", ("mapping.csv", f, "text/csv"))], timeout=120)
upload.raise_for_status()

# AI replies can take several minutes
reply = requests.post(f"{BASE}/chat/{session_id}/messages", headers=HEADERS,
                      json={"message": "Review the mapping sheet"}, timeout=600)
reply.raise_for_status()
print(reply.json()["assistantMessage"]["content"])
```

### Node.js (18 or later)

Save as `list-sessions.mjs` and run `node list-sessions.mjs`:

```js
const BASE = 'https://migration-agent.uat.signify.net.nz/api';
const headers = { Authorization: `Bearer ${process.env.CIRCINI_API_KEY}` };

const res = await fetch(`${BASE}/sessions?limit=5`, { headers });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const { sessions, nextCursor } = await res.json();
console.log(sessions.map(s => s.name), 'next page cursor:', nextCursor);
```

Live logs for a session, using `socket.io-client`:

```js
import { io } from 'socket.io-client';

const socket = io('https://migration-agent.uat.signify.net.nz', {
  path: '/api/socket.io',
  auth: { token: process.env.CIRCINI_API_KEY },
});
socket.on('connect', () => socket.emit('join-session', sessionId, ack => console.log('joined:', ack.ok)));
socket.on('log', entry => console.log(entry.step, entry.message));
```

### Postman, Insomnia or Bruno

1. Create an environment variable named `circini_api_key`. In Postman, set its
   type to **secret** and put the key only in **Current value**, which stays on
   your computer; the initial value is shared with your team.
2. On the request or collection, set **Authorization → Bearer Token** to
   `{{circini_api_key}}`.
3. Do not export or share collections or environments that contain the key.

### CI pipelines and servers

Store the key in the platform's secret store and pass it in as an environment
variable. GitHub Actions example:

```yaml
- name: Call Circini
  env:
    CIRCINI_API_KEY: ${{ secrets.CIRCINI_API_KEY }}
  run: |
    curl -fsS -H "Authorization: Bearer $CIRCINI_API_KEY" \
      https://migration-agent.uat.signify.net.nz/api/auth/me
```

### Phones, tablets and browser apps

Do not put a key inside a mobile app, browser extension or web page. Anyone with
the app can extract it, and it carries full admin access; browsers on other
sites are also blocked from calling the API. Use the web app on phones, and send
automation through a server you control that holds the key.

## 5. Endpoint reference

List endpoints return one page at a time: pass `limit` (default 50, maximum 100)
and, for the next page, `cursor` set to the previous response's `nextCursor`.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Health check; no key needed |
| GET | `/api/auth/me` | The user the key acts as |
| GET | `/api/sessions?limit=&cursor=` | List sessions (admins see all users') |
| POST | `/api/sessions` | Create a session: `{ "name": "..." }` |
| GET | `/api/sessions/:id` | A session with its messages |
| PATCH | `/api/sessions/:id` | Rename: `{ "name": "..." }` |
| DELETE | `/api/sessions/:id` | Delete a session |
| GET | `/api/sessions/:id/outputs` | Generated files for a session |
| GET | `/api/chat/:sessionId/messages` | Messages in a session |
| POST | `/api/chat/:sessionId/messages` | Send a message: `{ "message": "..." }`. Can take up to 10 minutes |
| POST | `/api/files/:sessionId/upload` | Upload files as multipart field `files`: up to 10 files, 10 MB each |
| GET | `/api/files/:sessionId` | Uploaded files for a session |
| GET | `/api/files/uploaded/:fileId/content` | Uploaded file content |
| GET | `/api/files/uploaded/:fileId/download` | Download an uploaded file |
| DELETE | `/api/files/:fileId` | Delete an uploaded file |
| GET | `/api/files/output/:outputId/download` | Download a generated output |
| POST | `/api/files/output/:outputId/test` | Validate a generated output |
| GET | `/api/files/output/:outputId/validation` | Read an output's validation result |
| GET | `/api/integrations` | The key owner's integration connections |
| GET | `/api/admin/users` | List users with usage |
| POST | `/api/admin/users` | Create a user |
| PATCH | `/api/admin/users/:id` | Change role, status, name or token limits |
| POST | `/api/admin/users/:id/revoke` | Revoke a user's access |
| GET | `/api/admin/usage/summary?days=30` | Token usage and cost |
| GET | `/api/admin/audit` | Audit event log |
| GET | `/api/admin/ailogs` | AI activity logs |
| GET | `/api/admin/security/summary` | Guardrail and denial summary |
| GET | `/api/admin/security/configuration` | Active security configuration |

Accepted upload types: `xlsx`, `xls`, `csv`, `tsv`, `json`, `yaml`, `yml`, `xml`,
`md`, `txt`, `sql`, `py`, `js`, `ts`, `log`, `ddl`, `env`.

## 6. Status codes

| Code | Meaning |
|---|---|
| `200` / `201` / `204` | Success |
| `400` | The request body or parameters are invalid |
| `401` | No key, a mistyped key, or a key that is expired, revoked or inactive |
| `403` | The endpoint does not accept API keys (key management), voice is unavailable, or no access to that item |
| `404` | Not found |
| `422` | Content was blocked by screening and was not stored |
| `429` | The admin's token budget is used up |
| `503` | A safety service (content screening or audit) is unavailable. Nothing was changed; try again later |

## 7. Keeping keys safe

- Create **one key per device or system** and name it after that device, so you
  can revoke just that key if the device is lost or retired.
- Choose the **shortest expiry** that works.
- **Never** paste a key into chats, tickets, emails, screenshots or source code,
  and never commit it to git.
- If a key is exposed, **revoke it immediately**, create a new one and update the
  places that use it.
- A lost key cannot be recovered, because only its hash is stored. Create a new
  one instead.

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `The token '&&' is not a valid statement separator` | A macOS/Linux command was run in Windows PowerShell. Use the Windows commands above |
| `curl` in PowerShell asks for parameters or prints odd output | Use `curl.exe` |
| `401` right after an admin edited the key owner | Their role or status changed, so the key is now **Inactive**. Create a new key |
| Chat requests time out | Raise the client timeout to 10 minutes |
| `/api/sessions` prints a huge response | It returns up to 50 sessions with message previews. Use `?limit=5`, or `/api/auth/me` for a quick test |
