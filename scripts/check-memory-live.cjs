// Runs inside the deployed backend. Proves both halves of LangGraph memory against
// the live stack: a standing instruction saved in one chat (DynamoDB store, no TTL)
// is recalled in a different chat, and erasing it takes effect.
//
// This check writes to memory that nothing expires, so it purges before and after:
// a test preference must never outlive the run that made it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {PrismaClient} = require(process.cwd() + '/node_modules/@prisma/client');
const {generateApiKey} = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
let token, keyId, userId, phase = 'initialize';
const evidence = {};
function mark(value) {phase = value; console.log(JSON.stringify({memoryProgress: value}));}
// Assertion messages written here are safe to log; a generated one quotes the
// compared values, which may be chat content, so report only a code.
function failureReason(error) {
  return error instanceof assert.AssertionError && error.generatedMessage === false
    ? error.message : (error?.code || error?.name || 'unknown');
}
const FIXTURE_PREFIX = 'E2E memory ';
// A session is renamed to the first 50 characters of its first message
// (routes/chat.ts), so by the end of a run the prefix is gone and a sweep by
// name finds nothing. Chats are deleted by the ids this run created, and the
// sweep also matches the invented schema name, which only this check writes.
// Two markers, because the last chat of a run is the one that proves an erased
// instruction is NOT applied — so nothing in it carries the schema name. Its
// question is the second marker; only this check ever asks it.
const RECALL_QUESTION = 'Which Snowflake schema should a new staging model target?';
const FIXTURE_PHRASES = ['RAW_VAULT_', RECALL_QUESTION];
const created = [];

async function request(method, path, body, expected = 200) {
  const response = await fetch(base + path, {method,
    headers: {'content-type': 'application/json', Authorization: `Bearer ${token}`},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600000)});
  assert.equal(response.status, expected, `${phase}: HTTP status`);
  return response.json();
}
const api = (path, body, expected = 200) => request('POST', path, body, expected);
const chat = (session, message) => api(`/api/chat/${session}/messages`, {message, fileRefs: []});

async function purgeFixtures() {
  const stale = await prisma.session.findMany({where: {ownerUserId: userId, OR: [
    {id: {in: created}},
    {name: {startsWith: FIXTURE_PREFIX}},
    ...FIXTURE_PHRASES.map(phrase => ({messages: {some: {content: {contains: phrase}}}})),
  ]}, select: {id: true}});
  for (const session of stale) {
    // Through the API where possible: deleting a chat there also deletes its
    // LangGraph checkpoints, which a direct row delete would leave to expire.
    const deleted = await fetch(`${base}/api/sessions/${session.id}`,
      {method: 'DELETE', headers: {Authorization: `Bearer ${token}`}});
    if (!deleted.ok) await prisma.session.delete({where: {id: session.id}});
  }
  created.length = 0;
  const {forgotten} = await request('DELETE', `/api/admin/users/${userId}/memory`);
  return {sessions: stale.length, memories: forgotten};
}

async function main() {
  const user = await prisma.user.findUniqueOrThrow({where: {email: 'sagar@callsphere.ai'}});
  assert.equal(user.status, 'active');
  assert.equal(user.role, 'admin');
  userId = user.id;
  const minted = generateApiKey(); token = minted.key;
  keyId = (await prisma.apiKey.create({data: {userId: user.id, name: 'E2E long-term memory', prefix: minted.prefix,
    keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 1800000)}})).id;

  mark('clear memory and chats from earlier runs');
  evidence.purged = await purgeFixtures();

  // A preference no model would guess, so recall cannot be luck.
  const nonce = crypto.randomBytes(3).toString('hex');
  const schema = `RAW_VAULT_${nonce.toUpperCase()}`;
  mark('state a standing instruction in one chat');
  const first = (await api('/api/sessions', {name: `${FIXTURE_PREFIX}${nonce} source`}, 201)).id;
  created.push(first);
  const saved = await chat(first, `From now on, every model we build must target the Snowflake schema `
    + `${schema}. Please remember that for all my future chats.`);
  assert.ok(saved.assistantMessage.content, 'No reply to the instruction');

  mark('verify it was written to the store');
  const held = await request('GET', `/api/admin/users/${userId}/memory`);
  assert.ok(held.memories.some(m => (m.text || '').includes(schema)),
    'Standing instruction was not written to long-term memory');

  mark('verify a different chat recalls it');
  const second = (await api('/api/sessions', {name: `${FIXTURE_PREFIX}${nonce} recall`}, 201)).id;
  created.push(second);
  const recalled = await chat(second, RECALL_QUESTION);
  assert.ok(recalled.assistantMessage.content.includes(schema),
    'A new chat did not recall the standing instruction');
  evidence.recalledInNewChat = true;

  mark('verify erasing memory takes effect');
  const {forgotten} = await request('DELETE', `/api/admin/users/${userId}/memory`);
  assert.ok(forgotten >= 1, 'Nothing was erased');
  const empty = await request('GET', `/api/admin/users/${userId}/memory`);
  assert.equal(empty.memories.length, 0, 'Memory survived erasure');
  const third = (await api('/api/sessions', {name: `${FIXTURE_PREFIX}${nonce} after-erase`}, 201)).id;
  created.push(third);
  const after = await chat(third, RECALL_QUESTION);
  assert.ok(!after.assistantMessage.content.includes(schema), 'An erased instruction was still applied');
  evidence.erased = forgotten;

  mark('remove this run\'s fixtures');
  evidence.cleanedUp = await purgeFixtures();
  await prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}});
  assert.equal((await fetch(base + '/api/sessions', {headers: {Authorization: `Bearer ${token}`}})).status, 401);
  // The key is gone, so the cleanup in finally must not try to use it again.
  keyId = undefined; token = undefined;
  console.log(JSON.stringify({memoryProductionCheck: 'passed', ...evidence}));
}

main().catch(error => {
  console.error(JSON.stringify({memoryProductionCheck: 'failed', phase, reason: failureReason(error)}));
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (userId && token) await purgeFixtures();
    if (keyId) await prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}});
  } catch { console.error('Memory check cleanup failed; the key expires automatically'); process.exitCode = 1; }
  await prisma.$disconnect();
});
