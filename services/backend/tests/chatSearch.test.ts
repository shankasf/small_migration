import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { backfillChatChunks, indexNextChatChunk, searchChatHistory, historyWithFileEvidence } from '../src/services/chatSearch.js';
import { snapshotFile, referenceData } from '../src/services/fileLibrary.js';
import chatSearchRouter from '../src/routes/chatSearch.js';

const url = new URL(process.env.DATABASE_URL || 'http://invalid');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/migration_security_test') {
  throw new Error('Tests require isolated local migration_security_test database');
}
const prisma = new PrismaClient();
let policy: Server, server: Server, base: string;
let owner: string, other: string, current: string, older: string, foreign: string;
let available = true, blocked = false;
const embedded: string[] = [];
function vector(text: string) {
  const v = Array<number>(1536).fill(0);
  v[/mapping|crosswalk/i.test(text) ? 0 : 1] = 1;
  return v;
}
before(async () => {
  policy = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/ai/files/embed') {
      if (!available) { res.writeHead(503); res.end('{}'); return; }
      embedded.push(...data.texts);
      res.end(JSON.stringify({ embeddings: data.texts.map(vector) }));
    } else {
      res.end(JSON.stringify({ ...data, files: Object.fromEntries(Object.entries(data.files || {}).map(([k,v]) => [k, String(v).replaceAll('SENSITIVE_MARKER', '[REDACTED]')])),
        history: [], guardrail: { decision: blocked ? 'blocked' : 'allow' } }));
    }
  });
  await new Promise<void>(r => policy.listen(Number(process.env.TEST_POLICY_PORT), '127.0.0.1', r));
  const app = express(); app.use(express.json()); app.locals.prisma = prisma;
  app.use('/api/internal/chat-search', chatSearchRouter);
  server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/internal/chat-search`;
  owner = (await prisma.user.create({ data: { email: `chat-${randomUUID()}@example.test` } })).id;
  other = (await prisma.user.create({ data: { email: `other-${randomUUID()}@example.test` } })).id;
  current = (await prisma.session.create({ data: { ownerUserId: owner, name: 'Current chat' } })).id;
  older = (await prisma.session.create({ data: { ownerUserId: owner, name: 'Older mapping discussion' } })).id;
  foreign = (await prisma.session.create({ data: { ownerUserId: other, name: 'Private chat' } })).id;
});
async function message(content: string, sessionId = older, role = 'user') {
  return prisma.message.create({ data: { sessionId, role, content } });
}
async function drain() {
  for (let n=0; n<100 && await backfillChatChunks(prisma); n++) {}
  for (let n=0; n<200 && await indexNextChatChunk(prisma); n++) {}
}
async function request(sessionId = current, actor = owner, args: unknown = { query: 'mapping', scope: 'all', offset: 0 }, key = process.env.INTERNAL_API_KEY) {
  return fetch(`${base}/${sessionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'x-internal-key': key } : {}) },
    body: JSON.stringify({ user_id: actor, operation: 'history', args }) });
}
test('unindexed old and long messages are searchable immediately; current/all scopes stay isolated', async () => {
  const wanted = await message('Earlier context. '.repeat(1500) + 'The mapping sheet is policy_crosswalk_2025.csv.');
  const hidden = await message('The mapping sheet is private.csv', foreign);
  available = false;
  try {
    const found = await searchChatHistory(prisma, owner, current, { q: 'mapping sheet', scope: 'all' });
    assert.ok(found.matches.some(m => m.messageId === wanted.id && m.excerpt.includes('policy_crosswalk_2025.csv')));
    assert.ok(!found.matches.some(m => m.messageId === hidden.id));
    assert.equal(found.semanticAvailable, false);
    assert.equal(found.semanticIndexComplete, false);
    assert.equal((await searchChatHistory(prisma, owner, current, { q: 'mapping sheet', scope: 'current' })).matches.length, 0);
  } finally { available = true; }
});
test('semantic paraphrases retrieve saved messages and preserve provenance without duplicate chunks', async () => {
  const wanted = await message('Use the crosswalk workbook customer_rules.xlsx for these transforms.');
  await drain();
  const found = await searchChatHistory(prisma, owner, current, { q: 'mapping', scope: 'all' });
  const hit = found.matches.find(m => m.messageId === wanted.id)!;
  assert.ok(hit); assert.equal(hit.role, 'user'); assert.equal(hit.sourceSessionName, 'Older mapping discussion');
  assert.equal(new Set(found.matches.map(m => m.messageId)).size, found.matches.length);
});
test('attached filenames survive history hydration and search; foreign references are excluded', async () => {
  const upload = await prisma.uploadedFile.create({ data: { sessionId: older, category: 'mapping', filename: 'attachment_mapping.csv', content: 'source,target' } });
  const asset = await snapshotFile(prisma, 'upload', upload);
  const hiddenUpload = await prisma.uploadedFile.create({ data: { sessionId: foreign, category: 'mapping', filename: 'secret_mapping.csv', content: 'secret,target' } });
  const hiddenAsset = await snapshotFile(prisma, 'upload', hiddenUpload);
  const m = await prisma.message.create({ data: { sessionId: current, role: 'user', content: 'Use this one', libraryRefs: { create: referenceData([asset, hiddenAsset]) } } });
  const history = await historyWithFileEvidence(prisma, owner, [m]);
  assert.match(history[0].content, /attachment_mapping.csv/); assert.ok(!history[0].content.includes('secret_mapping.csv'));
  available = false;
  try {
    const found = await searchChatHistory(prisma, owner, current, { q: 'attachment_mapping.csv', scope: 'current' });
    assert.equal(found.matches[0].messageId, m.id);
    assert.equal(found.matches[0].files.length, 1);
    assert.equal(found.matches[0].files[0].filename, 'attachment_mapping.csv');
  } finally { available = true; }
});
test('legacy attachments and generated filenames are discoverable, with file search scoped to the chat', async () => {
  const m = await message('Here is the result', older, 'assistant');
  const output = await prisma.generatedOutput.create({ data: { sessionId: older, messageId: m.id,
    filename: 'legacy_transform.sql', filepath: 'legacy_transform.sql', fileType: 'sql', content: 'select 1' } });
  await snapshotFile(prisma, 'output', output);
  const ref = await message('Please reuse this', current);
  await prisma.messageFileRef.create({ data: { messageId: ref.id, generatedOutputId: output.id,
    filename: output.filename, kind: 'output', sourceSessionId: older } });
  available = false;
  try {
    const found = await searchChatHistory(prisma, owner, current, { q: output.filename, scope: 'all' });
    assert.deepEqual(new Set(found.matches.map(row => row.messageId)), new Set([m.id, ref.id]));
    for (const scope of ['current', 'all']) {
      const response = await fetch(`${base}/${current}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY! },
        body: JSON.stringify({ user_id: owner, operation: 'files', args: { query: output.filename, scope, offset: 0 } }) });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.files.length, scope === 'all' ? 1 : 0);
    }
  } finally { available = true; }
});
test('history pagination returns distinct messages and ends accurately', async () => {
  for (let n=0; n<13; n++) await message(`pagination_marker ${n}`, current);
  available = false;
  try {
    const first = await searchChatHistory(prisma, owner, current, { q: 'pagination_marker', scope: 'current' });
    const second = await searchChatHistory(prisma, owner, current, { q: 'pagination_marker', scope: 'current', offset: first.nextOffset! });
    assert.equal(first.matches.length, 10); assert.equal(first.nextOffset, 10);
    assert.equal(second.matches.length, 3); assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.matches, ...second.matches].map(row => row.messageId)).size, 13);
  } finally { available = true; }
});
test('indexing sends screened text, retries outages and never embeds blocked messages', async () => {
  const m = await message('SENSITIVE_MARKER mapping test');
  await drain();
  assert.ok(embedded.some(t => t.includes('[REDACTED] mapping test')));
  assert.ok(!embedded.some(t => t.includes('SENSITIVE_MARKER')));
  const denied = await message('blocked mapping');
  await backfillChatChunks(prisma); blocked = true;
  try { while (await indexNextChatChunk(prisma)) {} } finally { blocked = false; }
  assert.equal((await prisma.messageSearchChunk.findFirstOrThrow({ where: { messageId: denied.id } })).indexStatus, 'blocked');
  assert.ok(!embedded.includes('blocked mapping'));
  const retry = await message('retry mapping'); await backfillChatChunks(prisma); available = false;
  try { while (await indexNextChatChunk(prisma)) {} } finally { available = true; }
  assert.equal((await prisma.messageSearchChunk.findFirstOrThrow({ where: { messageId: retry.id } })).indexStatus, 'retry');
  await prisma.message.delete({ where: { id: m.id } });
  assert.equal(await prisma.messageSearchChunk.count({ where: { messageId: m.id } }), 0);
});
test('internal endpoint rejects unauthenticated, foreign, disabled and invalid searches, and screens results', async () => {
  assert.equal((await request(current, owner, undefined, '')).status, 401);
  assert.equal((await request(foreign)).status, 403);
  assert.equal((await request(current, other)).status, 403);
  assert.equal((await request(current, owner, { query: '', scope: 'all', offset: 0 })).status, 400);
  assert.equal((await request(current, owner, { query: 'mapping', scope: 'all', offset: -1 })).status, 400);
  await prisma.user.update({ where: { id: owner }, data: { status: 'disabled' } });
  assert.equal((await request()).status, 403);
  await prisma.user.update({ where: { id: owner }, data: { status: 'active' } });
  blocked = true;
  try { assert.equal((await request()).status, 422); } finally { blocked = false; }
  const result = await request(); assert.equal(result.status, 200);
  const data = await result.json(); assert.ok(data.matches.length); assert.ok(data.matches.every((m: any) => m.sourceSessionId !== foreign));
});
after(async () => {
  await prisma.session.deleteMany({ where: { id: { in: [current, older, foreign].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, other].filter(Boolean) } } });
  await prisma.$disconnect();
  for (const s of [server, policy]) { s?.closeAllConnections(); await new Promise<void>(r => s?.close(() => r())); }
});
