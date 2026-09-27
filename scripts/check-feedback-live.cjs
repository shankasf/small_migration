// Executes in the deployed backend image; credentials stay inside the task.
// Exercises the response-feedback rubric through the public API end to end:
// thumb, 1-5 score, note, transcript read-back, admin aggregate and filter.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PrismaClient } = require(process.cwd() + '/node_modules/@prisma/client');
const { generateApiKey } = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
let token, keyId, sessionId, phase = 'initialize';
const evidence = {};
function failureReason(error) {
  return error instanceof assert.AssertionError && error.generatedMessage === false
    ? error.message : (error?.code || error?.name || 'unknown');
}
function mark(value) { phase = value; console.log(JSON.stringify({ feedbackProgress: value })); }
async function call(method, path, body, expected = 200) {
  const response = await fetch(base + path, { method,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, expected, `${phase}: HTTP status`);
  return response.json();
}
// Fixture chats get renamed, so sweep earlier runs by content, never by name.
const FIXTURE_PHRASE = 'E2E feedback rubric fixture ';
async function main() {
  const user = await prisma.user.findUnique({ where: { email: 'sagar@callsphere.ai' } });
  assert.equal(user?.role, 'admin'); assert.equal(user.status, 'active');
  const stale = await prisma.session.findMany({ where: { ownerUserId: user.id,
    messages: { some: { content: { startsWith: FIXTURE_PHRASE } } } }, select: { id: true } });
  for (const s of stale) await prisma.session.delete({ where: { id: s.id } });
  evidence.purgedFixtures = stale.length;
  const minted = generateApiKey(); token = minted.key;
  keyId = (await prisma.apiKey.create({ data: { userId: user.id, name: 'E2E feedback rubric', prefix: minted.prefix,
    keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 900000) } })).id;
  const nonce = crypto.randomBytes(4).toString('hex');
  mark('prepare a rated response');
  sessionId = (await call('POST', '/api/sessions', { name: `E2E feedback ${nonce}` }, 201)).id;
  // The response is written directly: this check grades the feedback path, not the model.
  const message = await prisma.message.create({ data: { sessionId, role: 'assistant',
    content: `${FIXTURE_PHRASE}${nonce}: generated the staging model.` } });
  const rate = (body, expected) => call('PUT', `/api/feedback/messages/${message.id}`, body, expected);
  mark('score a thumbs up');
  assert.equal((await rate({ rating: 'up', score: 4 })).score, 4, 'Score was not saved with the thumbs up');
  await rate({ rating: 'up', score: 7 }, 400);
  await rate({ rating: 'down', score: 3 }, 400);
  const noted = await rate({ rating: 'up', note: `rubric check ${nonce}` });
  assert.equal(noted.score, 4, 'Saving a note dropped the score');
  mark('read the score back from the transcript');
  const thread = await call('GET', `/api/sessions/${sessionId}`);
  const rated = thread.messages.find(m => m.id === message.id);
  assert.equal(rated?.feedback?.score, 4, 'Transcript did not carry the score');
  mark('verify the admin aggregate and filter');
  const admin = await call('GET', '/api/admin/feedback?score=4&days=7');
  assert.ok(admin.entries.some(e => e.messageId === message.id && e.score === 4), 'Admin score filter missed the entry');
  assert.ok(admin.summary.scored >= 1 && admin.summary.averageScore >= 1 && admin.summary.averageScore <= 5,
    'Admin summary has no rubric average');
  assert.equal(admin.summary.scoreDistribution.length, 5);
  mark('switching to thumbs down clears the score');
  const down = await rate({ rating: 'down' });
  assert.equal(down.score, null, 'Thumbs down kept the rubric score');
  assert.equal(down.note, `rubric check ${nonce}`, 'Switching the thumb dropped the note');
  await call('DELETE', `/api/feedback/messages/${message.id}`);
  evidence.rubric = 'passed';
  console.log(JSON.stringify({ feedbackProductionCheck: 'passed', ...evidence }));
}
main().catch(error => { console.error(JSON.stringify({ feedbackProductionCheck: 'failed', phase, reason: failureReason(error) })); process.exitCode = 1; })
  .finally(async () => {
    try { if (sessionId) await prisma.session.delete({ where: { id: sessionId } }); }
    catch { console.error('Feedback fixture cleanup failed; next run sweeps it'); }
    try { if (keyId) await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } }); }
    catch { console.error('Feedback test key revocation failed; key expires automatically'); process.exitCode = 1; }
    await prisma.$disconnect();
  });
