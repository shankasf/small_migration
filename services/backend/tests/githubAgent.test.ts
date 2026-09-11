import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import express from 'express';
import axios from 'axios';
import type { Server } from 'node:http';
process.env.JWT_SECRET = randomBytes(40).toString('hex');
process.env.INTERNAL_API_KEY = randomBytes(32).toString('hex');
process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.GITHUB_APP_ID = '123';
let server: Server, base: string;
const originalGet = axios.get;
const rows = new Map<string, any>();
let calls: Array<{ url: string; actor: string }> = [];
let status = 'active', revoked = false, huge = false;
const sha = 'a'.repeat(40), treeSha = 'b'.repeat(40);
let encrypt: (value: Record<string, unknown>) => string;
const db: any = {
  user: { findUnique: async ({ where }: any) => ['alice', 'bob', 'admin', 'auditor'].includes(where.id)
    ? { id: where.id, role: where.id === 'admin' ? 'admin' : where.id === 'auditor' ? 'auditor' : 'analyst', status } : null },
  session: { findUnique: async ({ where }: any) => where.id === 'chat-alice' ? { ownerUserId: 'alice' } : null },
  integration: { findUnique: async ({ where }: any) => rows.get(where.userId_provider.userId) || null },
  auditEvent: { create: async ({ data }: any) => data },
  $queryRaw: async () => [], $transaction: async (fn: any) => fn(db),
};
before(async () => {
  encrypt = (await import('../src/services/integrationSecrets.js')).encryptIntegrationSecrets;
  const router = (await import('../src/routes/githubAgent.js')).default;
  axios.get = (async (url: string, config: any) => {
    const actor = config.headers.Authorization === 'Bearer token-admin' ? 'admin' : 'alice';
    calls.push({ url, actor });
    if (revoked) throw Object.assign(new Error('DO_NOT_EXPOSE_SECRET'), { isAxiosError: true, response: { status: 401 }, config });
    const installation = actor === 'admin' ? 22 : 11, repository = actor === 'admin' ? 202 : 101;
    if (url.includes('/user/installations?')) return { data: { installations: [{ id: installation, app_id: 123, suspended_at: null, account: { login: actor } }] } };
    if (url.includes(`/user/installations/${installation}/repositories?`)) return { data: { total_count: 1, repositories: [{ id: repository, full_name: `${actor}/dbt`, private: true, default_branch: 'main' }] } };
    if (url.includes(`/repositories/${repository}/commits/`)) return { data: { sha, commit: { tree: { sha: treeSha } } } };
    if (url.includes(`/repositories/${repository}/git/trees/`)) return { data: { truncated: false, tree: Array.from({ length: 605 }, (_, index) => ({ path: `models/stg_${index}.sql`, type: 'blob', size: 19, sha })) } };
    if (url.includes(`/repositories/${repository}/contents/`)) return { data: { type: 'file', path: 'models/stg_0.sql', sha, size: huge ? 300000 : 19, encoding: 'base64', content: Buffer.from('select 731 as value').toString('base64') } };
    throw new Error('Unexpected GitHub request');
  }) as any;
  const app = express(); app.use(express.json()); app.locals.prisma = db; app.use('/internal/github', router);
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(() => {
  status = 'active'; revoked = false; huge = false; calls = []; rows.clear();
  for (const actor of ['alice', 'admin']) rows.set(actor, { status: 'connected', encryptedSecrets: encrypt({ accessToken: `token-${actor}` }), metadata: {
    selectedRepository: { id: actor === 'admin' ? 202 : 101, installationId: actor === 'admin' ? 22 : 11, fullName: `${actor}/dbt`, branch: 'Feature-Review' },
  } });
});
after(() => { axios.get = originalGet; server.close(); });
async function call(operation: string, args = {}, actor = 'alice', key = process.env.INTERNAL_API_KEY) {
  const response = await fetch(`${base}/internal/github/chat-alice`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-internal-key': key } : {}) }, body: JSON.stringify({ user_id: actor, operation, args }) });
  return { status: response.status, data: await response.json() as any };
}
test('internal service authentication rejects anonymous and wrong keys before provider calls', async () => {
  assert.equal((await call('status', {}, 'alice', '')).status, 401);
  assert.equal((await call('status', {}, 'alice', 'wrong')).status, 401); assert.equal(calls.length, 0);
});
test('other user, auditor and restricted actor cannot use chat gateway', async () => {
  assert.equal((await call('status', {}, 'bob')).status, 403);
  assert.equal((await call('status', {}, 'auditor')).status, 403);
  status = 'restricted'; assert.equal((await call('status')).status, 403); assert.equal(calls.length, 0);
});
test('admin in another owner chat uses only admins own connection', async () => {
  const result = await call('file', { path: 'models/stg_0.sql' }, 'admin');
  assert.equal(result.status, 200); assert.equal(result.data.repository, 'admin/dbt');
  assert.ok(calls.every(item => item.actor === 'admin')); assert.ok(!JSON.stringify(result.data).includes('token-admin'));
});
test('disconnected account gets truthful status and cannot read', async () => {
  rows.delete('alice'); const result = await call('status'); assert.equal(result.data.status, 'not_connected');
  assert.equal((await call('file', { path: 'models/stg_0.sql' })).status, 409); assert.equal(calls.length, 0);
});
test('status verifies access and lists actual repositories without secrets', async () => {
  const result = await call('status'); assert.equal(result.status, 200); assert.equal(result.data.verified, true);
  const listed = await call('repositories'); assert.equal(listed.data.repositories[0].id, 101);
  assert.ok(!JSON.stringify([result.data, listed.data]).includes('token-alice'));
});
test('revoked credentials reject safely rather than claim access', async () => {
  revoked = true; const result = await call('status'); assert.equal(result.status, 409);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPOSE_SECRET')); assert.ok(!JSON.stringify(result).includes('token-alice'));
});
test('foreign repository and installation cannot bypass permission checks', async () => {
  assert.notEqual((await call('file', { repository_id: 202, installation_id: 22, path: 'models/stg_0.sql' })).status, 200);
  assert.notEqual((await call('file', { repository_id: 202, installation_id: 11, path: 'models/stg_0.sql' })).status, 200);
  assert.equal(calls.filter(item => item.url.includes('/contents/')).length, 0);
});
test('saved Feature-Review branch resolves to an immutable commit for reading', async () => {
  const result = await call('file', { path: 'models/stg_0.sql' }); assert.equal(result.status, 200);
  assert.equal(result.data.content, 'select 731 as value'); assert.equal(result.data.commitSha, sha);
  assert.ok(calls.some(item => item.url.endsWith('/commits/Feature-Review')));
  assert.ok(calls.some(item => item.url.endsWith(`/contents/models/stg_0.sql?ref=${sha}`)));
});
test('tree pagination is explicit', async () => {
  const first = await call('tree'); assert.equal(first.data.entries.length, 500); assert.equal(first.data.nextOffset, 500);
  const last = await call('tree', { offset: 500 }); assert.equal(last.data.entries.length, 105); assert.equal(last.data.hasMore, false);
});
test('traversal, oversized files and write operations reject', async () => {
  assert.equal((await call('file', { path: '../.env' })).status, 400);
  assert.equal((await call('file', { path: '/etc/passwd' })).status, 400);
  huge = true; assert.equal((await call('file', { path: 'models/stg_0.sql' })).status, 413);
  assert.equal((await call('push')).status, 400);
});
