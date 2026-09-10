import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import express from 'express';
import axios from 'axios';
import type { Server } from 'node:http';

process.env.JWT_SECRET = randomBytes(40).toString('hex');
process.env.AUTH_MODE = 'local';
process.env.GITHUB_CLIENT_ID = 'test-client';
process.env.GITHUB_CLIENT_SECRET = randomBytes(40).toString('hex');
process.env.GITHUB_APP_ID = '123';
process.env.GITHUB_APP_SLUG = 'test-circini';
process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.GITHUB_WEBHOOK_SECRET = randomBytes(40).toString('hex');
process.env.PUBLIC_APP_URL = 'https://migration.example.test';

let server: Server, base: string;
let states = new Map<string, any>(), rows = new Map<string, any>();
let userStatus = 'active', userRole = 'analyst', providerCalls = 0;
const originalGet = axios.get, originalPost = axios.post, originalDelete = axios.delete;
let service: typeof import('../src/services/githubApp.js');
let cryptoService: typeof import('../src/services/integrationSecrets.js');
const auditEvents: any[] = [];
const fakeDb: any = {
  auditEvent: { create: async (data: any) => { auditEvents.push(data); return data; } },
  user: { findUnique: async ({ where }: any) => ({ id: where.id, role: userRole, status: userStatus }) },
  integrationOAuthState: {
    create: async ({ data }: any) => { states.set(data.state, data); return data; },
    findUnique: async ({ where }: any) => states.get(where.state) || null,
    deleteMany: async ({ where }: any) => {
      let count = 0;
      for (const [key, item] of states) {
        if (where.state && where.state !== key) continue;
        if (where.userId && where.userId !== item.userId) continue;
        if (where.provider && where.provider !== item.provider) continue;
        if (where.expiresAt?.lt && item.expiresAt >= where.expiresAt.lt) continue;
        if (where.expiresAt?.gt && item.expiresAt <= where.expiresAt.gt) continue;
        states.delete(key); count++;
      }
      return { count };
    },
  },
  integration: {
    findUnique: async ({ where }: any) => rows.get(where.userId_provider.userId) || null,
    findUniqueOrThrow: async ({ where }: any) => { const row = rows.get(where.userId_provider.userId); if (!row) throw new Error('missing'); return row; },
    upsert: async ({ where, create, update }: any) => {
      const id = where.userId_provider.userId;
      const row = rows.has(id) ? { ...rows.get(id), ...update } : { id, ...create };
      rows.set(id, row); return row;
    },
    update: async ({ where, data }: any) => {
      const row = rows.get(where.id); Object.assign(row, data); return row;
    },
    updateMany: async ({ where, data }: any) => {
      const row = rows.get(where.id); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 };
    },
    deleteMany: async ({ where }: any) => {
      let count = 0;
      for (const [id, row] of rows) {
        if (where.userId && id !== where.userId) continue;
        if (where.metadata && row.metadata.externalId !== where.metadata.equals) continue;
        rows.delete(id); count++;
      }
      return { count };
    },
  },
  $queryRaw: async () => [],
  $transaction: async (fn: any) => fn(fakeDb),
};

before(async () => {
  service = await import('../src/services/githubApp.js');
  cryptoService = await import('../src/services/integrationSecrets.js');
  const routers = await import('../src/routes/github.js');
  axios.get = (async (url: string, config: any) => {
    providerCalls++;
    const token = config.headers.Authorization;
    if (url.endsWith('/user')) return { data: { id: 42, login: 'alice', html_url: 'https://github.com/alice' } };
    if (url.includes('/user/installations?')) return { data: { installations: [{ id: 55, app_id: 123, account: { login: 'alice' }, suspended_at: null }] } };
    if (url.includes('/user/installations/55/repositories')) {
      assert.ok(['Bearer user-alice', 'Bearer fresh-alice'].includes(token));
      return { data: { repositories: [{ id: 10, full_name: 'alice/repo', private: true, default_branch: 'main' }] } };
    }
    if (url.includes('/repositories/10/branches')) return { data: url.includes('?') ? [{ name: 'main' }] : { name: 'main' } };
    throw new Error(`Unexpected GitHub request: ${url}`);
  }) as any;
  axios.post = (async (_url: string, body: URLSearchParams) => {
    providerCalls++;
    return { data: { access_token: body.get('grant_type') === 'refresh_token' ? 'fresh-alice' : 'user-alice',
      refresh_token: 'refresh-alice', expires_in: 28800, refresh_token_expires_in: 15897600 } };
  }) as any;
  axios.delete = (async () => ({ status: 204 })) as any;
  const app = express();
  app.locals.prisma = fakeDb;
  app.use('/api/integrations', routers.githubWebhookRouter);
  app.use(express.json());
  app.use('/api/integrations', routers.githubCallbackRouter);
  app.use((req: any, res, next) => {
    if (!req.headers['x-test-user']) return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: req.headers['x-test-user'], role: req.headers['x-test-role'] || 'analyst', status: 'active' }; next();
  });
  app.use('/api/integrations', routers.githubRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/integrations`;
});

after(() => { axios.get = originalGet; axios.post = originalPost; axios.delete = originalDelete; server?.close(); });

async function connect(user = 'alice') {
  const response = await fetch(`${base}/github/connect`, { method: 'POST', headers: { 'x-test-user': user } });
  assert.equal(response.status, 200);
  return new URL((await response.json()).authorizeUrl);
}

test('ordinary users can connect with PKCE and account selection; unauthenticated and read-only users cannot', async () => {
  assert.equal((await fetch(`${base}/github/connect`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/github/connect`, { method: 'POST', headers: { 'x-test-user': 'auditor', 'x-test-role': 'auditor' } })).status, 403);
  const url = await connect();
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('scope'), false);
  assert.ok(url.searchParams.get('state')!.length >= 40);
});

test('forged/expired/cross-provider callback states never contact GitHub', async () => {
  const before = providerCalls;
  states.set('old', { state: 'old', provider: 'github', expiresAt: new Date(0), userId: 'alice' });
  states.set('gitlab', { state: 'gitlab', provider: 'gitlab', expiresAt: new Date(Date.now() + 60000), userId: 'alice' });
  for (const state of ['forged', 'old', 'gitlab']) {
    const response = await fetch(`${base}/github/callback?code=fake&state=${state}`, { redirect: 'manual' });
    assert.match(response.headers.get('location')!, /result=expired/);
  }
  assert.equal(providerCalls, before);
});

test('callback consumes state once and stores encrypted tokens only on its initiating user', async () => {
  const url = await connect();
  const state = url.searchParams.get('state');
  const callback = `${base}/github/callback?code=fake&state=${state}`;
  const response = await fetch(callback, { redirect: 'manual', headers: { 'x-test-user': 'mallory' } });
  assert.match(response.headers.get('location')!, /result=connected/);
  assert.ok(rows.has('alice')); assert.equal(rows.has('mallory'), false);
  assert.equal(rows.get('alice').encryptedSecrets.includes('user-alice'), false);
  const before = providerCalls;
  assert.match((await fetch(callback, { redirect: 'manual' })).headers.get('location')!, /result=expired/);
  assert.equal(providerCalls, before);
});

test('disabled users and users downgraded to auditor cannot complete a pending connection', async () => {
  for (const restricted of ['disabled', 'auditor']) {
    const url = await connect(); const before = providerCalls;
    userStatus = restricted === 'disabled' ? 'disabled' : 'active'; userRole = restricted === 'auditor' ? 'auditor' : 'analyst';
    const response = await fetch(`${base}/github/callback?code=fake&state=${url.searchParams.get('state')}`, { redirect: 'manual' });
    assert.match(response.headers.get('location')!, /result=expired/); assert.equal(providerCalls, before);
  }
  userStatus = 'active'; userRole = 'analyst';
});

test('an installation id alone cannot bind an account or grant repository access', async () => {
  const before = providerCalls, size = rows.size;
  const response = await fetch(`${base}/github/callback?installation_id=999&code=untrusted`, { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(providerCalls, before); assert.equal(rows.size, size);
});

test('repository listing is private to the authenticated user and excludes tokens', async () => {
  const response = await fetch(`${base}/github/repositories`, { headers: { 'x-test-user': 'alice' } });
  assert.equal(response.status, 200);
  const body = await response.text(); assert.match(body, /alice\/repo/); assert.doesNotMatch(body, /user-alice|refresh-alice/);
  const other = await fetch(`${base}/github/repositories`, { headers: { 'x-test-user': 'mallory' } });
  assert.equal(other.status, 400); assert.doesNotMatch(await other.text(), /alice\/repo/);
});

test('repository selection rejects another installation or a repository outside the installation', async () => {
  for (const data of [{ installationId: 999, repositoryId: 10 }, { installationId: 55, repositoryId: 999 }]) {
    const response = await fetch(`${base}/github/repository`, { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify({ ...data, branch: 'main' }) });
    assert.equal(response.status, 400);
  }
  const response = await fetch(`${base}/github/repository`, { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify({ installationId: 55, repositoryId: 10, branch: 'main' }) });
  assert.equal(response.status, 200); assert.equal(rows.get('alice').metadata.selectedRepository.id, 10);
});

test('expired user tokens refresh and replacement tokens remain encrypted', async () => {
  rows.get('alice').encryptedSecrets = cryptoService.encryptIntegrationSecrets({ accessToken: 'expired', refreshToken: 'refresh-alice', expiresAt: Date.now() - 1 });
  assert.equal(await service.githubUserToken(fakeDb, 'alice'), 'fresh-alice');
  assert.equal(rows.get('alice').encryptedSecrets.includes('fresh-alice'), false);
});

test('webhook verifies original bytes and rejects missing/malformed/tampered signatures', async () => {
  const body = JSON.stringify({ zen: 'test' });
  const signature = 'sha256=' + createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(body).digest('hex');
  assert.equal(service.validGithubSignature(Buffer.from(body), signature), true);
  for (const sig of ['', 'sha256=bad', signature]) {
    const response = await fetch(`${base}/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': 'ping' }, body: body + ' ' });
    assert.equal(response.status, 401);
  }
  const valid = await fetch(`${base}/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-event': 'ping' }, body });
  assert.equal(valid.status, 200);
});

test('disconnect removes only the callers connection and pending states', async () => {
  rows.set('bob', { id: 'bob', metadata: {}, encryptedSecrets: cryptoService.encryptIntegrationSecrets({ accessToken: 'bob' }) });
  await connect('alice'); await connect('bob');
  const response = await fetch(`${base}/github`, { method: 'DELETE', headers: { 'x-test-user': 'alice' } });
  assert.equal(response.status, 204); assert.equal(rows.has('alice'), false); assert.equal(rows.has('bob'), true);
  assert.equal([...states.values()].some(item => item.userId === 'alice' && item.provider === 'github'), false);
  assert.equal([...states.values()].some(item => item.userId === 'bob'), true);
});
