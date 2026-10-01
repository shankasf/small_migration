import assert from 'node:assert/strict';
import {before, beforeEach, after, test} from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import express from 'express';
import axios from 'axios';

process.env.JWT_SECRET = randomBytes(40).toString('hex');
process.env.INTERNAL_API_KEY = randomBytes(32).toString('hex');
process.env.AUTH_MODE = 'local';
let server: Server, base: string, token: string, keyHash: string;
let owner: any, key: any, grant: any, auditFail = false;
let calls: any[] = [], audits: any[] = [], upstreamStatus = 0;
const sessionId = randomUUID(), foreignId = randomUUID(), assetId = randomUUID();
const originalRequest = axios.request;
const names: Record<string, string[]> = {list_files: [], get_file_content: ['file_name'],
  remember: ['subject', 'fact'], forget: ['subject'], read_impact_evidence: ['source', 'operation', 'parameters'],
  request_file_delivery: ['file_id', 'filename']};
const tools = Object.entries(names).map(([name, fields]) => ({name, readOnly: !['remember', 'forget'].includes(name),
  inputSchema: {properties: Object.fromEntries(fields.map(field => [field, {type: 'string'}]))}}));
const db: any = {
  apiKey: {findUnique: async ({where}: any) => where.keyHash === keyHash ? {...key, user: owner} : null,
    update: async () => ({})},
  session: {findUnique: async ({where}: any) => [sessionId, foreignId].includes(where.id)
    ? {id: where.id, ownerUserId: where.id === sessionId ? owner.id : 'other', impactState: grant} : null},
  uploadedFile: {findMany: async ({where}: any) => {
    assert.equal(where.sessionId, sessionId); return [{filename: 'owned.sql', content: 'select 731'}];
  }},
  fileAsset: {findMany: async ({where}: any) => {
    assert.equal(where.session.ownerUserId, owner.id);
    return where.id.in.includes(assetId) ? [{id: assetId, filename: 'history.sql', version: 2,
      sessionId, content: 'select 732'}] : [];
  }},
  auditEvent: {create: async ({data}: any) => {if (auditFail) throw new Error('audit down'); audits.push(data); return data;}},
};
before(async () => {
  const {generateApiKey} = await import('../src/services/apiKeys.js');
  const minted = generateApiKey(); token = minted.key; keyHash = minted.keyHash;
  const {authenticate} = await import('../src/middleware/auth.js');
  const router = (await import('../src/routes/capabilities.js')).default;
  axios.request = (async (config: any) => {
    calls.push(config);
    assert.equal(config.headers['x-internal-key'], process.env.INTERNAL_API_KEY);
    assert.equal(config.maxRedirects, 0);
    if (config.url.endsWith('/execute')) {
      if (upstreamStatus) throw Object.assign(new Error('SECRET_MUST_NOT_LEAK'), {isAxiosError: true,
        response: {status: upstreamStatus, data: {detail: 'SECRET_MUST_NOT_LEAK'}}});
      return {data: {ok: true, result: config.data.files, guardrail: {decision: 'allow'}}};
    }
    return {data: config.url.endsWith('/agents') ? {agents: [{id: 'consultant', tools: ['list_files', 'remember']}]}
      : {tools}};
  }) as any;
  const app = express(); app.use(express.json()); app.locals.prisma = db;
  app.use(authenticate(db)); app.use('/api', router);
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(() => {
  owner = {id: 'owner', role: 'admin', status: 'active', tokensValidAfter: null};
  key = {id: 'key', createdAt: new Date(), expiresAt: new Date(Date.now() + 60000), revokedAt: null, lastUsedAt: new Date()};
  grant = null; calls = []; audits = []; auditFail = false; upstreamStatus = 0;
});
async function get(path: string, credential = token) {
  return fetch(base + path, {headers: credential ? {Authorization: `Bearer ${credential}`} : {}});
}
async function execute(name = 'list_files', body: any = {sessionId, arguments: {}}) {
  return fetch(`${base}/api/tools/${name}/execute`, {method: 'POST',
    headers: {Authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(body)});
}
test('catalogues require a valid key; expiration and revocation are enforced', async () => {
  assert.equal((await get('/api/agents', '')).status, 401);
  assert.equal((await get('/api/tools', 'invalid')).status, 401);
  assert.equal((await get('/api/agents')).status, 200);
  key.revokedAt = new Date(); assert.equal((await get('/api/tools')).status, 401);
  key.revokedAt = null; key.expiresAt = new Date(0); assert.equal((await get('/api/tools')).status, 401);
});
test('per-agent catalogue filters tools and rejects unknown agents', async () => {
  const response = await get('/api/agents/consultant/tools');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tools.map((t: any) => t.name), ['list_files', 'remember']);
  assert.equal((await get('/api/agents/unknown/tools')).status, 404);
});
test('execution binds actor, session, grant and files on the server and audits results', async () => {
  const response = await execute(); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.ok, true); assert.ok(data.executionId);
  const sent = calls.find(c => c.url.endsWith('/execute')).data;
  assert.equal(sent.user_id, owner.id); assert.equal(sent.session_id, sessionId);
  assert.equal(sent.impact_state, null); assert.deepEqual(sent.files, {'owned.sql': 'select 731'});
  assert.deepEqual(audits.map(a => a.action), ['tool.execute', 'tool.result']);
});
test('even admin keys cannot execute in another owner session', async () => {
  assert.equal((await execute('list_files', {sessionId: foreignId})).status, 403);
  assert.equal(calls.length, 0);
});
test('caller-supplied identity, unknown arguments, oversized input and unknown tools reject', async () => {
  for (const body of [{sessionId, user_id: 'other'}, {sessionId, arguments: {runtime: {}}},
    {sessionId, arguments: {query: 'x'.repeat(16001)}}, {sessionId, arguments: []}]) {
    assert.equal((await execute('list_files', body)).status, 400);
  }
  assert.equal((await execute('not_a_tool')).status, 404);
  assert.ok(!calls.some(c => c.url.endsWith('/execute')));
});
test('restricted and disabled accounts cannot execute', async () => {
  owner.status = 'restricted'; assert.equal((await execute()).status, 403);
  owner.status = 'disabled'; assert.equal((await execute()).status, 401);
  assert.ok(!calls.some(c => c.url.endsWith('/execute')));
});
test('memory mutations require explicit confirmation', async () => {
  const body = {sessionId, arguments: {subject: 'schema', fact: 'Use STAGING_TEST'}};
  assert.equal((await execute('remember', body)).status, 400);
  assert.equal((await execute('remember', {...body, confirm: true})).status, 200);
});
test('impact evidence accepts only the saved owner grant and confirmed sources', async () => {
  const body = {sessionId, arguments: {source: 'github', operation: 'status'}};
  assert.equal((await execute('read_impact_evidence', body)).status, 403);
  grant = {id: 'analysis', userId: owner.id, phase: 'confirmed', sources: ['uploads'], request: 'test', startedAt: new Date().toISOString()};
  assert.equal((await execute('read_impact_evidence', body)).status, 403);
  grant.sources = ['github']; assert.equal((await execute('read_impact_evidence', body)).status, 200);
  assert.equal(calls.find(c => c.url.endsWith('/execute')).data.impact_state.id, 'analysis');
});
test('file references preserve version labels; delivery checks ownership before execution', async () => {
  const response = await execute('list_files', {sessionId, fileRefs: [assetId]});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result[`history.sql [v2; ${assetId}]`], 'select 732');
  assert.equal((await execute('request_file_delivery', {sessionId, arguments: {file_id: randomUUID(), filename: 'foreign.sql'}})).status, 403);
  const delivered = await execute('request_file_delivery', {sessionId, arguments: {file_id: assetId, filename: 'spoofed.sql'}});
  const data = await delivered.json(); assert.equal(data.result.filename, 'history.sql');
  assert.equal(data.result.downloadUrl, `/api/files/library/${assetId}/download`);
});
test('audit failure prevents invocation and upstream errors never leak details', async () => {
  auditFail = true; assert.equal((await execute()).status, 503);
  assert.ok(!calls.some(c => c.url.endsWith('/execute')));
  auditFail = false;
  for (const status of [400, 403, 422, 500]) {
    upstreamStatus = status; const response = await execute();
    assert.equal(response.status, status === 500 ? 503 : status);
    assert.ok(!(await response.text()).includes('SECRET_MUST_NOT_LEAK'));
  }
});
after(async () => {
  axios.request = originalRequest;
  server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve()));
});
