// Executes in the deployed backend image; credentials stay inside the task.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PrismaClient } = require(process.cwd() + '/node_modules/@prisma/client');
const { generateApiKey } = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
let token, keyId, phase = 'initialize';
const evidence = {};
// Assertion messages written in this file are safe to log; a generated one
// quotes the compared values, which may be chat content, so report only a code.
function failureReason(error) {
  return error instanceof assert.AssertionError && error.generatedMessage === false
    ? error.message : (error?.code || error?.name || 'unknown');
}
function mark(value) { phase = value; console.log(JSON.stringify({ chatSearchProgress: value })); }
async function api(path, body, expected = 200, internal = false) {
  const response = await fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(internal ? { 'x-internal-key': process.env.INTERNAL_API_KEY } : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
  assert.equal(response.status, expected, `${phase}: HTTP status`);
  return response.json();
}
const FIXTURE_PREFIX = 'E2E chat search ';
// Each run used to leave its synthetic chats behind, and the paraphrase check
// below searches for words the saved message never contains ("mapping sheet"),
// so it is ranked purely semantically. Earlier runs' recall QUESTIONS — "the
// mapping sheet filename for the synthetic cedar <nonce> migration" — are a
// near-exact match for that query and outrank this run's saved message, which
// only ever says "crosswalk workbook". Every deploy added two more of them, so
// the target eventually fell past the LIMIT 10 and the gate began failing on a
// ranking artefact of its own debris. The check now clears its own fixtures
// first. Deletes cascade to messages, chunks, file assets and outputs; usage
// and audit records denormalise sessionId and are kept.
async function purgeFixtures(ownerUserId) {
  const stale = await prisma.session.findMany({
    where: { ownerUserId, name: { startsWith: FIXTURE_PREFIX } }, select: { id: true } });
  for (const session of stale) await prisma.session.delete({ where: { id: session.id } });
  return stale.length;
}
async function main() {
  const user = await prisma.user.findUnique({ where: { email: 'sagar@callsphere.ai' } });
  assert.equal(user?.role, 'admin'); assert.equal(user.status, 'active');
  evidence.purgedFixtures = await purgeFixtures(user.id);
  const minted = generateApiKey(); token = minted.key;
  const key = await prisma.apiKey.create({ data: { userId: user.id, name: 'E2E chat history search', prefix: minted.prefix,
    keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 1800000) } }); keyId = key.id;
  const nonce = crypto.randomBytes(4).toString('hex');
  const filename = `crosswalk_${nonce}.csv`;
  const project = `synthetic cedar ${nonce}`;
  const source = await api('/api/sessions', { name: `${FIXTURE_PREFIX}${nonce} source` }, 201);
  const target = await api('/api/sessions', { name: `${FIXTURE_PREFIX}${nonce} recall` }, 201);
  evidence.sourceSessionId = source.id; evidence.targetSessionId = target.id;
  mark('prepare synthetic earlier chat');
  const form = new FormData();
  form.append('files', new Blob(['source_column,target_column\nlegacy_code,target_code\n'], { type: 'text/csv' }), filename);
  const uploaded = await fetch(`${base}/api/files/${source.id}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(uploaded.status, 201);
  const asset = await prisma.fileAsset.findFirstOrThrow({ where: { sessionId: source.id, filename } });
  const saved = await prisma.message.create({ data: { sessionId: source.id, role: 'user',
    content: `For the ${project} migration, the source-to-target crosswalk workbook is ${filename}. It describes how legacy fields correspond to destination columns.`,
    libraryRefs: { create: { assetId: asset.id, filename, version: asset.version, kind: asset.kind, sourceSessionId: source.id } } } });
  const search = (query, scope) => api(`/api/internal/chat-search/${target.id}`, { user_id: user.id, operation: 'history', args: { query, scope, offset: 0 } }, 200, true);
  mark('verify immediate history and scope');
  const immediate = await search(filename, 'all');
  assert.ok(immediate.matches.some(m => m.messageId === saved.id && m.files.some(f => f.assetId === asset.id)),
    'Filename search missed the saved message or its attachment');
  assert.ok(!(await search(filename, 'current')).matches.some(m => m.messageId === saved.id),
    'scope=current leaked a message from another session');
  assert.equal((await fetch(`${base}/api/internal/chat-search/${target.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const foreign = await prisma.session.findFirst({ where: { ownerUserId: { not: user.id } }, select: { id: true } });
  if (foreign) await api(`/api/internal/chat-search/${foreign.id}`, { user_id: user.id, operation: 'history', args: { query: filename, scope: 'all', offset: 0 } }, 403, true);
  mark('wait for production semantic index');
  const deadline = Date.now() + 600000;
  while (!(await prisma.messageSearchChunk.count({ where: { messageId: saved.id, indexStatus: 'ready' } }))) {
    assert.ok(Date.now() < deadline, 'Chat index did not become ready');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  const semantic = await search(`mapping sheet for ${project}`, 'all');
  assert.equal(semantic.semanticAvailable, true, 'Query embedding failed, so only keyword search was available');
  assert.ok(semantic.matches.some(m => m.messageId === saved.id), 'Paraphrased history query missed saved message');
  evidence.semanticSearch = 'passed';
  mark('ask chatbot to recall file without attaching it');
  const since = new Date();
  const reply = await api(`/api/chat/${target.id}/messages`, { message: `Can you share the mapping sheet filename for the ${project} migration from my earlier chats?`, fileRefs: [] });
  assert.ok(reply.assistantMessage.content.includes(filename), 'Chatbot did not identify earlier chat filename');
  const tools = await prisma.aiActivityLog.findMany({ where: { sessionId: target.id, createdAt: { gte: since }, step: 'tool.call' }, select: { tool: true } });
  assert.ok(tools.some(t => t.tool === 'search_chat_history'), 'Chatbot did not search saved messages');
  assert.ok(!tools.some(t => /github/.test(t.tool || '')), 'Chat lookup incorrectly switched to GitHub');
  mark('verify short follow-up keeps topic and source');
  const followup = await api(`/api/chat/${target.id}/messages`, { message: 'No, from the chat. Give me its exact filename and the source chat.', fileRefs: [] });
  assert.ok(followup.assistantMessage.content.includes(filename), 'Follow-up lost the mapping filename');
  evidence.filename = filename; evidence.chatRecall = 'passed'; evidence.followup = 'passed'; evidence.tools = tools.map(t => t.tool);
  await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  assert.equal((await fetch(base + '/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  keyId = undefined; token = undefined;
  console.log(JSON.stringify({ chatSearchProductionCheck: 'passed', ...evidence }));
}
main().catch(error => { console.error(JSON.stringify({ chatSearchProductionCheck: 'failed', phase, reason: failureReason(error) })); process.exitCode = 1; })
  .finally(async () => {
    try { if (keyId) await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } }); }
    catch { console.error('Chat search test key revocation failed; key expires automatically'); process.exitCode = 1; }
    await prisma.$disconnect();
  });
