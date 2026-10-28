// Executes in the deployed backend image; credentials stay inside the task.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PrismaClient } = require(process.cwd() + '/node_modules/@prisma/client');
const { generateApiKey } = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
let token, keyId, userId, phase = 'initialize';
const createdSessions = [];
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
// Keep this gate independent of real accounts, saved memories and earlier runs.
// Delete only the sessions and identity created by this invocation.
async function cleanupFixtures() {
  for (const id of createdSessions) {
    const response = token && await fetch(`${base}/api/sessions/${id}`, {
      method: 'DELETE', headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(30000),
    });
    if (!response || !response.ok) await prisma.session.deleteMany({where: {id, ownerUserId: userId}});
  }
  createdSessions.length = 0;
}
async function main() {
  const user = await prisma.user.create({data: {email: `chat-search-check-${crypto.randomUUID()}@example.test`, role: 'admin'}});
  userId = user.id;
  assert.equal(user?.role, 'admin'); assert.equal(user.status, 'active');
  const minted = generateApiKey(); token = minted.key;
  const key = await prisma.apiKey.create({ data: { userId: user.id, name: 'E2E chat history search', prefix: minted.prefix,
    keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 1800000) } }); keyId = key.id;
  const nonce = crypto.randomBytes(4).toString('hex');
  const filename = `crosswalk_${nonce}.csv`;
  const project = `synthetic cedar ${nonce}`;
  const source = await api('/api/sessions', { name: `${FIXTURE_PREFIX}${nonce} source` }, 201);
  createdSessions.push(source.id);
  const target = await api('/api/sessions', { name: `${FIXTURE_PREFIX}${nonce} recall` }, 201);
  createdSessions.push(target.id);
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
  // Diagnostics before the assertion: a recall failure otherwise leaves no trace of what was searched.
  // Everything logged here is this check's own synthetic fixture.
  const searches = await prisma.aiActivityLog.findMany({ where: { sessionId: target.id, createdAt: { gte: since }, step: 'tool.call' }, select: { tool: true, detail: true } });
  console.log(JSON.stringify({ chatSearchProgress: 'recall diagnostics',
    searches: searches.map(s => ({ tool: s.tool, args: JSON.stringify(s.detail?.arguments || {}).slice(0, 200) })),
    replyExcerpt: (reply.assistantMessage.content || '').slice(0, 300) }));
  assert.ok(reply.assistantMessage.content.includes(filename), 'Chatbot did not identify earlier chat filename');
  const tools = searches;
  assert.ok(tools.some(t => t.tool === 'search_chat_history'), 'Chatbot did not search saved messages');
  assert.ok(!tools.some(t => /github/.test(t.tool || '')), 'Chat lookup incorrectly switched to GitHub');
  mark('verify short follow-up keeps topic and source');
  const followup = await api(`/api/chat/${target.id}/messages`, { message: 'No, from the chat. Give me its exact filename and the source chat.', fileRefs: [] });
  assert.ok(followup.assistantMessage.content.includes(filename), 'Follow-up lost the mapping filename');
  evidence.filename = filename; evidence.chatRecall = 'passed'; evidence.followup = 'passed'; evidence.tools = tools.map(t => t.tool);
  // Naming the file is not delivering it: a user who asks for the file itself
  // must get a downloadable copy attached to the reply, in this chat.
  mark('verify the chatbot hands over the file itself');
  const delivery = await api(`/api/chat/${target.id}/messages`, { message: 'Give me that file here so I can download it.', fileRefs: [] });
  const attached = (delivery.savedOutputs || []).find(output => output.filename === filename);
  assert.ok(attached, 'Chatbot did not attach the requested file to its reply');
  const download = await fetch(`${base}/api/files/output/${attached.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(download.status, 200, 'Attached file did not download');
  assert.ok((await download.text()).includes('legacy_code'), 'Delivered file did not carry the earlier chat file content');
  evidence.fileDelivery = 'passed';
  await cleanupFixtures();
  await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  assert.equal((await fetch(base + '/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  keyId = undefined; token = undefined;
  console.log(JSON.stringify({ chatSearchProductionCheck: 'passed', ...evidence }));
}
main().catch(error => { console.error(JSON.stringify({ chatSearchProductionCheck: 'failed', phase, reason: failureReason(error) })); process.exitCode = 1; })
  .finally(async () => {
    try {
      await cleanupFixtures();
      if (keyId) await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
      if (userId) await prisma.user.delete({where: {id: userId}});
    }
    catch { console.error('Chat search test key revocation failed; key expires automatically'); process.exitCode = 1; }
    await prisma.$disconnect();
  });
