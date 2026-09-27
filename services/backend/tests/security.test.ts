import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server as HttpServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as clientIo, Socket } from 'socket.io-client';
import { PrismaClient, User } from '@prisma/client';
import { authenticate, issueToken, tokenIsCurrent } from '../src/middleware/auth.js';
import { installRealtime } from '../src/services/realtime.js';
import { recordAudit, scrubAuditDetail } from '../src/services/audit.js';
import { retentionPolicy } from '../src/services/retention.js';

const url = new URL(process.env.DATABASE_URL || 'http://invalid');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('/migration_security_test')) {
  throw new Error('Tests require an isolated local migration_security_test database');
}
const prisma = new PrismaClient();
let server: HttpServer;
let io: Server;
let policy: HttpServer;
let base: string;
let owner: User, other: User, admin: User, auditor: User;
let ownerToken: string, otherToken: string;
let sessionId: string;
let screeningMode = 'allow';
const sockets: Socket[] = [];

before(async () => {
  policy = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (screeningMode === 'unavailable') { res.writeHead(503); res.end('{}'); return; }
    const input = JSON.parse(body || '{}');
    const blocked = screeningMode === 'blocked';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({message: blocked ? '' : (input.message || '').replaceAll('private@example.com', '[EMAIL_REDACTED]'),
      files: blocked ? {} : Object.fromEntries(Object.entries(input.files || {}).map(([k,v]) => [k, String(v).replaceAll('private@example.com', '[EMAIL_REDACTED]')])),
      history: [], guardrail: {decision: blocked ? 'blocked' : 'redacted', reasons: ['test_policy']}, error: 'Blocked'}));
  });
  await new Promise<void>(r => policy.listen(Number(process.env.TEST_POLICY_PORT), '127.0.0.1', r));
  // The service endpoint is set by the test command before modules load.
  const address = policy.address() as {port: number};
  // Tests proxy the fixed AI test port rather than touching any real provider.
  assert.equal(address.port, Number(process.env.TEST_POLICY_PORT));
  const app = express(); app.use(express.json()); app.locals.prisma = prisma;
  server = createServer(app); io = new Server(server, {path: '/api/socket.io'});
  app.locals.io = io; app.locals.recordAiEvent = () => {};
  installRealtime(io, prisma);
  app.use(authenticate(prisma));
  app.use('/api/files', (await import('../src/routes/files.js')).default);
  app.use('/api/chat', (await import('../src/routes/chat.js')).default);
  app.use('/api/feedback', (await import('../src/routes/feedback.js')).default);
  app.use('/api/sessions', (await import('../src/routes/sessions.js')).default);
  app.use('/api/stt', (await import('../src/routes/stt.js')).default);
  app.use('/api/admin', (await import('../src/routes/admin.js')).default);
  app.use('/api/api-keys', (await import('../src/routes/apiKeys.js')).default);
  const {PolicyError} = await import('../src/services/aiService.js');
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof PolicyError ? 422 : 503).json({error: 'blocked'});
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  await prisma.user.deleteMany(); await prisma.session.deleteMany();
  owner = await prisma.user.create({data: {email:'owner@example.test', role:'analyst'}});
  other = await prisma.user.create({data: {email:'other@example.test', role:'analyst'}});
  admin = await prisma.user.create({data: {email:'admin@example.test', role:'admin'}});
  auditor = await prisma.user.create({data: {email:'auditor@example.test', role:'auditor'}});
  ownerToken = await issueToken(owner); otherToken = await issueToken(other);
  sessionId = (await prisma.session.create({data: {ownerUserId:owner.id}})).id;
});

async function request(path: string, token = ownerToken, options: RequestInit = {}) {
  return fetch(base + path, {...options, headers: {...options.headers, Authorization: `Bearer ${token}`}});
}
async function socket(token: string) {
  const s = clientIo(base, {path:'/api/socket.io', auth:{token}, transports:['websocket'], reconnection:false});
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {s.once('connect', resolve); s.once('connect_error', reject);});
  return s;
}

// Integration contract: the policy service is exercised independently by Python tests.
test('blocked prompts are rejected before storage', async () => {
  screeningMode = 'blocked';
  const res = await request(`/api/chat/${sessionId}/messages`, ownerToken, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:'sensitive payload'})});
  assert.equal(res.status, 422);
  assert.equal(await prisma.message.count({where:{sessionId}}), 0);
});
test('blocked uploads and screening outages do not persist data', async () => {
  for (const mode of ['blocked','unavailable']) {
    screeningMode = mode;
    const form = new FormData(); form.append('files', new Blob(['private@example.com']), 'mapping.csv');
    const res = await request(`/api/files/${sessionId}/upload`, ownerToken, {method:'POST', body:form});
    assert.equal(res.status, mode === 'blocked' ? 422 : 503);
    assert.equal(await prisma.uploadedFile.count({where:{sessionId}}), 0);
  }
});
test('only redacted upload content is persisted', async () => {
  screeningMode = 'allow';
  const form = new FormData(); form.append('files', new Blob(['private@example.com']), 'mapping.csv');
  assert.equal((await request(`/api/files/${sessionId}/upload`, ownerToken, {method:'POST', body:form})).status, 201);
  assert.equal((await prisma.uploadedFile.findFirstOrThrow({where:{sessionId}})).content, '[EMAIL_REDACTED]');
});
test('another analyst and auditors cannot read session artefacts', async () => {
  for (const token of [otherToken, await issueToken(auditor)]) {
    assert.equal((await request(`/api/sessions/${sessionId}`, token)).status, 403);
    assert.equal((await request(`/api/files/${sessionId}`, token)).status, 403);
  }
});
test('socket ownership and admin room checks are enforced', async () => {
  const s = await socket(otherToken);
  const denied = await s.timeout(2000).emitWithAck('join-session', sessionId);
  assert.equal(denied.ok, false);
  assert.equal((await s.timeout(2000).emitWithAck('join-admin-logs')).ok, false);
  const owned = await socket(ownerToken);
  assert.equal((await owned.timeout(2000).emitWithAck('join-session', sessionId)).ok, true);
});
test('revocation disconnects sockets and invalidates old HTTP tokens', async () => {
  const s = await socket(otherToken);
  const disconnected = new Promise<void>(resolve => s.once('disconnect', () => resolve()));
  const response = await request(`/api/admin/users/${other.id}/revoke`, await issueToken(admin), {method:'POST'});
  assert.equal(response.status, 200);
  await disconnected;
  assert.equal((await request('/api/sessions', otherToken)).status, 401);
});
test('voice refuses content and auditors cannot upload', async () => {
  assert.equal((await request('/api/stt', ownerToken, {method:'POST'})).status, 403);
  assert.equal((await request(`/api/files/${sessionId}/upload`, await issueToken(auditor), {method:'POST'})).status, 403);
});
test('audit records discard content and fail closed when required archive is missing', async () => {
  assert.equal(scrubAuditDetail(JSON.stringify({prompt:'private', password:'secret'})), '{}');
  process.env.AUDIT_ARCHIVE_REQUIRED = 'true';
  await assert.rejects(recordAudit(prisma, {action:'test'}), /Durable audit unavailable/);
  delete process.env.AUDIT_ARCHIVE_REQUIRED;
});
test('retention is indefinite even if legacy expiry flags are present', async () => {
  process.env.RETENTION_DELETE_ENABLED = 'true';
  process.env.AI_LOG_RETENTION_DAYS = '1';
  const stale = await prisma.session.create({data:{ownerUserId:owner.id, updatedAt:new Date('2020-01-01')}});
  assert.equal(retentionPolicy.automaticDeletion, false);
  for (const value of Object.values(retentionPolicy).filter(v => typeof v === 'string')) assert.equal(value, 'indefinite');
  assert.ok(await prisma.session.findUnique({where:{id:stale.id}}));
  delete process.env.RETENTION_DELETE_ENABLED;
  delete process.env.AI_LOG_RETENTION_DAYS;
});
async function createApiKey(token: string) {
  const res = await request('/api/api-keys', token, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'ci', expiresInDays:30})});
  return {status: res.status, body: res.status === 201 ? await res.json() as {secret: string; key: {id: string; status: string}} : null};
}
test('only admins create API keys, only from a signed-in session, and only a digest is stored', async () => {
  assert.equal((await createApiKey(ownerToken)).status, 403);
  assert.equal((await createApiKey(await issueToken(auditor))).status, 403);
  const created = await createApiKey(await issueToken(admin));
  assert.equal(created.status, 201);
  const {secret, key} = created.body!;
  assert.match(secret, /^cmk_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.status, 'active');
  assert.ok(!JSON.stringify(await prisma.apiKey.findUniqueOrThrow({where:{id:key.id}})).includes(secret));
  assert.equal((await createApiKey(secret)).status, 403);
  assert.equal((await request('/api/api-keys', secret)).status, 403);
});
test('an API key acts as its admin over HTTP and sockets until revoked or expired', async () => {
  const adminToken = await issueToken(admin);
  const {secret, key} = (await createApiKey(adminToken)).body!;
  assert.equal((await request('/api/admin/users', secret)).status, 200);
  assert.equal((await request(`/api/sessions/${sessionId}`, secret)).status, 200);
  const s = await socket(secret);
  assert.equal((await s.timeout(2000).emitWithAck('join-admin-logs')).ok, true);
  assert.equal((await request(`/api/api-keys/${key.id}`, adminToken, {method:'DELETE'})).status, 204);
  assert.equal((await request('/api/sessions', secret)).status, 401);
  const expiring = (await createApiKey(adminToken)).body!;
  await prisma.apiKey.update({where:{id:expiring.key.id}, data:{expiresAt:new Date(Date.now() - 1000)}});
  assert.equal((await request('/api/sessions', expiring.secret)).status, 401);
});
test('API keys stop working when their admin is demoted or has access revoked', async () => {
  const adminToken = await issueToken(admin);
  for (const change of ['demote', 'revoke']) {
    const holder = await prisma.user.create({data:{email:`${change}-admin@example.test`, role:'admin'}});
    const {secret} = (await createApiKey(await issueToken(holder))).body!;
    assert.equal((await request('/api/sessions', secret)).status, 200);
    if (change === 'demote') await prisma.user.update({where:{id:holder.id}, data:{role:'analyst'}});
    else assert.equal((await request(`/api/admin/users/${holder.id}/revoke`, adminToken, {method:'POST'})).status, 200);
    assert.equal((await request('/api/sessions', secret)).status, 401);
  }
});
test('saving a user without changing role or status keeps their sessions and API keys', async () => {
  const adminToken = await issueToken(admin);
  const holder = await prisma.user.create({data:{email:'edited-admin@example.test', role:'admin'}});
  const holderToken = await issueToken(holder);
  const {secret} = (await createApiKey(holderToken)).body!;
  const save = (body: object) => request(`/api/admin/users/${holder.id}`, adminToken, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  assert.equal((await save({role:'admin', status:'active', dailyTokenLimit:5000})).status, 200);
  for (const credential of [holderToken, secret]) assert.equal((await request('/api/sessions', credential)).status, 200);
  assert.equal((await save({role:'admin', status:'restricted', dailyTokenLimit:5000})).status, 200);
  for (const credential of [holderToken, secret]) assert.equal((await request('/api/sessions', credential)).status, 401);
});

// ---- Response feedback: ratings follow the same row-level scoping as the
// transcript, and a note is user free text, so it crosses the policy boundary
// before it is stored.
const ratableMessage = () => prisma.message.create({data:{sessionId, role:'assistant', content:'Generated the staging model.'}});
const rate = (id: string, body: object, token = ownerToken) =>
  request(`/api/feedback/messages/${id}`, token, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});

test('ratings are refused to other analysts, auditors and non-assistant messages', async () => {
  screeningMode = 'allow';
  const message = await ratableMessage();
  const rival = await prisma.user.create({data:{email:'rival@example.test', role:'analyst'}});
  assert.equal((await rate(message.id, {rating:'up'}, await issueToken(rival))).status, 403);
  assert.equal((await rate(message.id, {rating:'up'}, await issueToken(auditor))).status, 403);
  assert.equal(await prisma.messageFeedback.count({where:{messageId:message.id}}), 0);
  const prompt = await prisma.message.create({data:{sessionId, role:'user', content:'Generate the staging model'}});
  assert.equal((await rate(prompt.id, {rating:'up'})).status, 400);
  assert.equal((await rate(message.id, {rating:'five-stars'})).status, 400);
  assert.equal((await rate('missing-message', {rating:'up'})).status, 404);
});
test('a rating is one per user: switching replaces it and withdrawing removes it', async () => {
  const message = await ratableMessage();
  assert.equal((await rate(message.id, {rating:'up'})).status, 200);
  assert.equal((await rate(message.id, {rating:'down'})).status, 200);
  assert.equal(await prisma.messageFeedback.count({where:{messageId:message.id}}), 1);
  assert.equal((await prisma.messageFeedback.findFirstOrThrow({where:{messageId:message.id}})).rating, 'down');
  assert.equal((await request(`/api/feedback/messages/${message.id}`, ownerToken, {method:'DELETE'})).status, 200);
  assert.equal(await prisma.messageFeedback.count({where:{messageId:message.id}}), 0);
});
test('only screened notes are persisted and a blocked note leaves the rating intact', async () => {
  const message = await ratableMessage();
  const saved = await rate(message.id, {rating:'down', note:'reach me at private@example.com'});
  assert.equal(saved.status, 200);
  assert.equal((await saved.json() as {note: string}).note, 'reach me at [EMAIL_REDACTED]');
  screeningMode = 'blocked';
  assert.equal((await rate(message.id, {rating:'down', note:'sensitive payload'})).status, 422);
  const stored = await prisma.messageFeedback.findFirstOrThrow({where:{messageId:message.id}});
  assert.equal(stored.note, 'reach me at [EMAIL_REDACTED]');
  assert.equal(stored.rating, 'down');
  screeningMode = 'allow';
});
test('a rubric score grades a thumbs up only and follows the thumb', async () => {
  const message = await ratableMessage();
  const stored = () => prisma.messageFeedback.findFirstOrThrow({where:{messageId:message.id}});
  for (const score of [0, 6, 3.5, '4']) {
    assert.equal((await rate(message.id, {rating:'up', score})).status, 400);
  }
  assert.equal((await rate(message.id, {rating:'down', score:4})).status, 400);
  const saved = await rate(message.id, {rating:'up', score:4});
  assert.equal(saved.status, 200);
  assert.equal((await saved.json() as {score: number}).score, 4);
  // Saving a note (score key omitted) keeps the grade; null clears it.
  assert.equal((await rate(message.id, {rating:'up', note:'minor tweak needed'})).status, 200);
  assert.equal((await stored()).score, 4);
  assert.equal((await rate(message.id, {rating:'up', score:null})).status, 200);
  assert.equal((await stored()).score, null);
  // Switching to a thumbs down takes the grade with it, but keeps the note.
  assert.equal((await rate(message.id, {rating:'up', score:5})).status, 200);
  assert.equal((await rate(message.id, {rating:'down'})).status, 200);
  const down = await stored();
  assert.equal(down.score, null);
  assert.equal(down.note, 'minor tweak needed');
});
test('a transcript carries the reader\'s own rating and nobody else\'s', async () => {
  const message = await ratableMessage();
  assert.equal((await rate(message.id, {rating:'up', note:'exactly what I needed'})).status, 200);
  const read = async (token: string) => {
    const res = await request(`/api/sessions/${sessionId}`, token);
    assert.equal(res.status, 200);
    const body = await res.json() as {messages: Array<{id: string; feedback: {rating: string; note: string} | null}>};
    return body.messages.find(m => m.id === message.id)!;
  };
  const mine = await read(ownerToken);
  assert.equal(mine.feedback?.rating, 'up');
  assert.equal(mine.feedback?.note, 'exactly what I needed');
  // An admin can read the thread, but ratings are private to whoever left them.
  assert.equal((await read(await issueToken(admin))).feedback, null);
});
test('feedback across all users is admin-only and carries the thread it came from', async () => {
  const message = await ratableMessage();
  assert.equal((await rate(message.id, {rating:'up', note:'clear and correct'})).status, 200);
  for (const token of [ownerToken, await issueToken(auditor)]) {
    assert.equal((await request('/api/admin/feedback', token)).status, 403);
  }
  const res = await request('/api/admin/feedback', await issueToken(admin));
  assert.equal(res.status, 200);
  const body = await res.json() as {summary: {total: number; up: number; withNotes: number};
    entries: Array<{note: string | null; userEmail: string; sessionId: string; prompt: string | null; rating: string; score: number | null}>};
  const entry = body.entries.find(e => e.note === 'clear and correct');
  assert.ok(entry, 'the admin view lists the note that was just left');
  assert.equal(entry!.userEmail, owner.email);
  assert.equal(entry!.sessionId, sessionId);
  assert.equal(entry!.rating, 'up');
  assert.ok(body.summary.total >= 1 && body.summary.withNotes >= 1);
});
test('the admin view averages rubric scores and filters by level', async () => {
  const graded = await ratableMessage();
  assert.equal((await rate(graded.id, {rating:'up', score:2, note:'rubric-two'})).status, 200);
  const adminToken = await issueToken(admin);
  const res = await request('/api/admin/feedback?score=2', adminToken);
  assert.equal(res.status, 200);
  const body = await res.json() as {summary: {scored: number; averageScore: number | null;
    scoreDistribution: Array<{score: number; count: number}>}; entries: Array<{score: number | null; note: string | null}>};
  assert.ok(body.entries.length >= 1 && body.entries.every(e => e.score === 2));
  assert.ok(body.entries.some(e => e.note === 'rubric-two'));
  assert.ok(body.summary.scored >= 1);
  assert.ok(body.summary.averageScore !== null && body.summary.averageScore >= 1 && body.summary.averageScore <= 5);
  assert.equal(body.summary.scoreDistribution.length, 5);
  const ungraded = await request('/api/admin/feedback?score=none', adminToken);
  const rows = (await ungraded.json() as {entries: Array<{score: number | null; rating: string}>}).entries;
  assert.ok(rows.every(e => e.rating === 'up' && e.score === null));
  const conflicting = await request('/api/admin/feedback?score=none&rating=down', adminToken);
  assert.equal((await conflicting.json() as {entries: unknown[]}).entries.length, 0);
});
test('concurrent first saves for one response settle on a single row', async () => {
  const message = await ratableMessage();
  const results = await Promise.all([rate(message.id, {rating:'up'}), rate(message.id, {rating:'up', score:3})]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(await prisma.messageFeedback.count({where:{messageId:message.id}}), 1);
});

after(async () => {
  for (const s of sockets) s.disconnect();
  await new Promise<void>(resolve => io?.close(() => resolve()));
  await new Promise<void>(resolve => policy?.close(() => resolve()));
  await prisma.$disconnect();
});
