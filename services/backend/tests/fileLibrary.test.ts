import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import {
  attachLibraryRefs, backfillFiles, indexNextFile, interpretFileQuery, referenceData,
  resolveFileRefs, searchFiles, snapshotFile,
} from '../src/services/fileLibrary.js';

const url = new URL(process.env.DATABASE_URL || 'http://invalid');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/migration_security_test') {
  throw new Error('Tests require an isolated local migration_security_test database');
}
const prisma = new PrismaClient();
const fixture = randomUUID();
let server: Server;
let ownerId: string, otherId: string, sessionId: string, nextSessionId: string, otherSessionId: string;
let embeddingsAvailable = true;

// Orthogonal topic vectors provide deterministic retrieval behavior without calling a provider.
function embedding(text: string): number[] {
  const vector = Array<number>(1536).fill(0);
  if (/customer|client/i.test(text)) vector[0] = 1;
  if (/invoice|billing/i.test(text)) vector[1] = 1;
  if (!vector[0] && !vector[1]) vector[2] = 1;
  const norm = Math.hypot(...vector);
  return vector.map(value => value / norm);
}

before(async () => {
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    assert.equal(req.headers['x-internal-key'], process.env.INTERNAL_API_KEY);
    if (req.url === '/ai/files/embed') {
      if (!embeddingsAvailable) { res.writeHead(503); res.end('{}'); return; }
      res.end(JSON.stringify({ embeddings: body.texts.map(embedding) }));
    } else if (req.url === '/ai/policy/check') {
      res.end(JSON.stringify({ ...body, history: body.history || [], guardrail: { decision: 'allow', reasons: [] } }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(Number(process.env.TEST_POLICY_PORT), '127.0.0.1', resolve));
  ownerId = (await prisma.user.create({ data: { email: `file-owner-${fixture}@example.test`, role: 'analyst' } })).id;
  otherId = (await prisma.user.create({ data: { email: `file-other-${fixture}@example.test`, role: 'analyst' } })).id;
  sessionId = (await prisma.session.create({ data: { ownerUserId: ownerId, name: 'Original migration' } })).id;
  nextSessionId = (await prisma.session.create({ data: { ownerUserId: ownerId, name: 'Resumed migration' } })).id;
  otherSessionId = (await prisma.session.create({ data: { ownerUserId: otherId, name: 'Private migration' } })).id;
});

async function snapshot(filename: string, content: string, overrides: { sessionId?: string; createdAt?: Date; id?: string; kind?: 'upload' | 'output' } = {}) {
  const { kind = 'upload', ...fields } = overrides;
  const data = { id: randomUUID(), sessionId, filename, content, ...fields };
  if (kind === 'upload') await prisma.uploadedFile.upsert({
    where: { id: data.id },
    create: { ...data, category: `fixture-${data.id}` },
    update: { content: data.content, filename: data.filename },
  });
  else await prisma.generatedOutput.create({ data: { ...data, filepath: filename, fileType: 'sql' } });
  return snapshotFile(prisma, kind, data);
}

test('upload revisions retain immutable bytes, deduplicate retry, and scope versions to the source chat', async () => {
  const sourceId = randomUUID();
  const first = await snapshot('revision.sql', 'SELECT 1 AS original;', { id: sourceId });
  const retry = await snapshot('revision.sql', 'SELECT 1 AS original;', { id: sourceId });
  const second = await snapshot('revision.sql', 'SELECT 2 AS revised;', { id: sourceId });
  const elsewhere = await snapshot('revision.sql', 'SELECT 3 AS elsewhere;', { sessionId: nextSessionId });
  assert.equal(retry.id, first.id);
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(elsewhere.version, 1);
  assert.notEqual(first.contentHash, second.contentHash);
  assert.equal((await prisma.fileAsset.findUniqueOrThrow({ where: { id: first.id } })).content, 'SELECT 1 AS original;');
  assert.deepEqual((await resolveFileRefs(prisma, ownerId, [first.id, second.id])).map(a => a.version), [1, 2]);
});

test('concurrent generated revisions allocate unique versions and preserve each result', async () => {
  const files = await Promise.all([1, 2, 3].map(n => snapshot('generated.sql', `SELECT ${n};`, { kind: 'output' })));
  assert.deepEqual(files.map(f => f.version).sort(), [1, 2, 3]);
  assert.equal(new Set(files.map(f => f.content)).size, 3);
});

test('hybrid search finds meaning and late exact code, deduplicates chunks, and isolates owners', async () => {
  const customer = await snapshot('stg_clients.sql', '-- client staging\nSELECT client_id FROM clients;');
  const lateCode = await snapshot('late_rule.sql', '-- A generic staging model\n'.repeat(300) + "\nWHERE country = 'US' AND unique_late_filter = true;");
  const hidden = await snapshot('private_clients.sql', 'SELECT secret FROM clients;', { sessionId: otherSessionId });
  for (let n = 0; n < 100 && await indexNextFile(prisma); n++) { /* drain isolated test queue */ }
  for (const file of [customer, lateCode, hidden]) {
    assert.equal((await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } })).indexStatus, 'ready');
  }
  const vectors = await prisma.$queryRaw<Array<{ dimensions: number }>>`SELECT vector_dims(embedding) AS dimensions FROM "FileChunk" WHERE "assetId"=${customer.id}`;
  assert.ok(vectors.length > 0 && vectors.every(row => row.dimensions === 1536));
  const semantic = await searchFiles(prisma, ownerId, { q: 'customer' });
  assert.equal(semantic.semanticAvailable, true);
  assert.ok(semantic.files.some(file => file.id === customer.id), 'customer matches client by deterministic semantic vector');
  assert.ok(!semantic.files.some(file => file.id === hidden.id), 'other owner excluded even with an equally strong match');
  assert.equal(new Set(semantic.files.map(file => file.id)).size, semantic.files.length);
  const exact = await searchFiles(prisma, ownerId, { q: 'unique_late_filter' });
  assert.ok(exact.files.some(file => file.id === lateCode.id));
  assert.match(exact.files.find(file => file.id === lateCode.id)!.excerpt, /unique_late_filter/);
  assert.ok(!lateCode.summary.includes('unique_late_filter'), 'match comes from content beyond summary');
});

test('keyword search remains available during embedding outages and date/source filters narrow results', async () => {
  const dated = await snapshot('archive_billing.sql', 'SELECT invoice_id FROM billing;', { kind: 'output', createdAt: new Date('2025-04-05T12:00:00Z') });
  embeddingsAvailable = false;
  try {
    const matches = await searchFiles(prisma, ownerId, { q: 'archive_billing', kind: 'output', from: new Date('2025-04-05'), to: new Date('2025-04-06') });
    assert.equal(matches.semanticAvailable, false);
    assert.deepEqual(matches.files.map(file => file.id), [dated.id]);
    assert.equal((await searchFiles(prisma, ownerId, { q: 'archive_billing', kind: 'upload' })).files.length, 0);
    assert.equal((await searchFiles(prisma, ownerId, { q: 'archive_billing', from: new Date('2025-04-06') })).files.length, 0);
  } finally { embeddingsAvailable = true; }
});

test('natural language search applies generated SQL and yesterday filters before retrieval', async () => {
  const parsed = interpretFileQuery('find customer SQL I generated yesterday', new Date('2026-09-10T17:45:00Z'));
  assert.equal(parsed.text, 'customer');
  assert.equal(parsed.kind, 'output');
  assert.equal(parsed.extension, '.sql');
  assert.equal(parsed.from!.toISOString(), '2026-09-09T00:00:00.000Z');
  assert.equal(parsed.to!.toISOString(), '2026-09-10T00:00:00.000Z');
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 12 * 3600000);
  const wanted = await snapshot('customer_yesterday.sql', 'SELECT customer_id;', { kind: 'output', createdAt: yesterday });
  await snapshot('customer_yesterday.csv', 'customer_id', { kind: 'output', createdAt: yesterday });
  await snapshot('customer_uploaded.sql', 'SELECT customer_id;', { createdAt: yesterday });
  await snapshot('customer_today.sql', 'SELECT customer_id;', { kind: 'output', createdAt: today });
  const found = await searchFiles(prisma, ownerId, { q: 'find customer SQL I generated yesterday' });
  assert.deepEqual(found.files.map(file => file.id), [wanted.id]);
});

test('exact filenames survive natural-language parsing and do not broaden to unrelated SQL files', async () => {
  const wanted = await snapshot('file.sql', 'SELECT expected_filename_match;');
  await snapshot('unrelated.sql', 'SELECT other_filename_match;');
  embeddingsAvailable = false;
  try {
    const found = await searchFiles(prisma, ownerId, { q: 'file.sql' });
    assert.deepEqual(found.files.map(file => file.id), [wanted.id]);
  } finally { embeddingsAvailable = true; }
});

test('large files remain keyword searchable beyond PostgreSQL whole-document tsvector limit', async () => {
  // About 2.5 MB, below the upload cap; a whole-document tsvector exceeds PostgreSQL's 1 MB limit.
  const content = Array.from({ length: 200000 }, (_, n) => `field_${n}`).join(' ') + '\nlarge_file_tail_marker';
  const file = await snapshot('large_model.sql', content);
  embeddingsAvailable = false;
  try {
    const found = await searchFiles(prisma, ownerId, { q: 'large_file_tail_marker' });
    assert.ok(found.files.some(item => item.id === file.id));
    assert.match(found.files.find(item => item.id === file.id)!.excerpt, /large_file_tail_marker/);
  } finally { embeddingsAvailable = true; }
});

test('reference validation rejects unknown, foreign, malformed and excessive IDs', async () => {
  const own = await snapshot('allowed.sql', 'SELECT 1;');
  const foreign = await snapshot('forbidden.sql', 'SELECT 2;', { sessionId: otherSessionId });
  for (const ids of [[foreign.id], [own.id, foreign.id], [randomUUID()]]) {
    await assert.rejects(resolveFileRefs(prisma, ownerId, ids), { statusCode: 403 });
  }
  for (const ids of [null, 'file.sql', ['bad'], Array.from({ length: 11 }, () => randomUUID())]) {
    await assert.rejects(resolveFileRefs(prisma, ownerId, ids), { statusCode: 400 });
  }
  assert.equal((await resolveFileRefs(prisma, ownerId, [own.id, own.id])).length, 1);
});

test('selected file/version identity survives message reload and later file revision', async () => {
  const first = await snapshot('pinned.sql', 'SELECT 1 AS pinned;');
  const message = await prisma.message.create({ data: {
    sessionId: nextSessionId, role: 'user', content: 'Use the selected original file',
    libraryRefs: { create: referenceData([first]) },
  } });
  await snapshot('pinned.sql', 'SELECT 2 AS newer;');
  const [hydrated] = await attachLibraryRefs(prisma, [await prisma.message.findUniqueOrThrow({ where: { id: message.id } })]);
  assert.equal(hydrated.fileRefs.length, 1);
  assert.equal(hydrated.fileRefs[0].assetId, first.id);
  assert.equal(hydrated.fileRefs[0].version, 1);
  assert.equal(hydrated.fileRefs[0].sourceSessionId, sessionId);
  assert.equal((await resolveFileRefs(prisma, ownerId, [hydrated.fileRefs[0].assetId]))[0].content, 'SELECT 1 AS pinned;');
});

test('legacy uploads and generated revisions are backfilled idempotently in chronological order', async () => {
  const upload = await prisma.uploadedFile.create({ data: { sessionId, filename: 'legacy.csv', category: 'legacy', content: 'column\nvalue', createdAt: new Date('2020-01-01') } });
  const outputs = [];
  for (const day of [1, 2]) outputs.push(await prisma.generatedOutput.create({ data: {
    sessionId, filename: 'legacy.sql', filepath: 'legacy.sql', fileType: 'sql', content: `SELECT ${day};`, createdAt: new Date(`2020-02-0${day}`),
  } }));
  for (let n = 0; n < 100 && await backfillFiles(prisma); n++) { /* bounded legacy batches */ }
  const snapshots = await prisma.fileAsset.findMany({ where: { sourceId: { in: [upload.id, ...outputs.map(o => o.id)] } }, orderBy: { createdAt: 'asc' } });
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.filter(a => a.kind === 'output').map(a => [a.version, a.content]), [[1, 'SELECT 1;'], [2, 'SELECT 2;']]);
  assert.equal(await backfillFiles(prisma), 0);
});

test('deleted sources cascade snapshots and a stale backfill cannot resurrect their content', async () => {
  for (const kind of ['upload', 'output'] as const) {
    const file = await snapshot(`deleted-${kind}.sql`, 'SELECT deleted_source;', { kind });
    const staleRecord = { id: file.sourceId, sessionId: file.sessionId, filename: file.filename, content: file.content };
    if (kind === 'upload') await prisma.uploadedFile.delete({ where: { id: file.sourceId } });
    else await prisma.generatedOutput.delete({ where: { id: file.sourceId } });
    assert.equal(await prisma.fileAsset.count({ where: { id: file.id } }), 0);
    await assert.rejects(snapshotFile(prisma, kind, staleRecord));
    assert.equal(await prisma.fileAsset.count({ where: { kind, sourceId: file.sourceId } }), 0);
  }
});

after(async () => {
  await prisma.session.deleteMany({ where: { id: { in: [sessionId, nextSessionId, otherSessionId].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId].filter(Boolean) } } });
  await prisma.$disconnect();
  server?.closeAllConnections();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});
