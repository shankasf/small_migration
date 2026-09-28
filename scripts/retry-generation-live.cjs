// Explicitly invoked operator recovery: appends two real turns to the named chat.
// Existing messages/files are retained. Credentials never leave the task.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {PrismaClient} = require(process.cwd() + '/node_modules/@prisma/client');
const {generateApiKey} = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const sessionId = process.env.GENERATION_RETRY_SESSION_ID;
const failedTurnId = process.env.GENERATION_RETRY_TURN_ID;
const mode = process.env.GENERATION_RETRY_MODE || 'retry';
let keyId, token;
async function main() {
  for (const id of [sessionId, failedTurnId]) assert.match(id || '', /^[a-f0-9-]{36}$/, 'An explicit chat and failed turn are required');
  const session = await prisma.session.findUniqueOrThrow({where: {id: sessionId}, include: {owner: true}});
  assert.equal(session.owner?.status, 'active', 'The chat owner must be active');
  const failed = await prisma.aiActivityLog.findFirstOrThrow({where: {sessionId, turnId: failedTurnId,
    step: 'model.author', type: 'warning'}});
  assert.equal(failed.userId, session.ownerUserId, 'The failed turn must belong to this chat owner');
  if (mode === 'inspect') {
    const messages = await prisma.message.findMany({where: {sessionId, role: 'assistant'},
      orderBy: {createdAt: 'desc'}, take: 3, select: {id: true, createdAt: true, content: true}});
    const files = await prisma.generatedOutput.findMany({where: {sessionId}, orderBy: {createdAt: 'desc'},
      take: 3, select: {id: true, messageId: true, filename: true, validation: true, createdAt: true}});
    console.log(JSON.stringify({agentGraphProductionCheck: 'passed', inspection: true, sessionId, files,
      messages: messages.map(m => ({id: m.id, createdAt: m.createdAt,
        reviewIssues: m.content.includes('**Still open after review')
          ? m.content.slice(m.content.indexOf('**Still open after review')) : '',
        failure: m.content.includes('no file was saved') ? m.content.slice(-1000) : ''}))}));
    return;
  }
  assert.ok(['retry', 'resolve_review'].includes(mode), 'Unknown verification mode');
  const original = await prisma.message.findFirstOrThrow({where: {sessionId, role: 'user',
    createdAt: {lte: failed.createdAt}}, orderBy: {createdAt: 'desc'}});
  const minted = generateApiKey(); token = minted.key;
  keyId = (await prisma.apiKey.create({data: {userId: session.ownerUserId, name: 'Authorized generation recovery',
    prefix: minted.prefix, keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 1800000)}})).id;
  const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
  async function chat(message) {
    const response = await fetch(`${base}/api/chat/${sessionId}/messages`, {method: 'POST',
      headers: {'content-type': 'application/json', Authorization: `Bearer ${token}`},
      body: JSON.stringify({message, fileRefs: []}), signal: AbortSignal.timeout(900000)});
    assert.equal(response.status, 200, 'The authenticated chat request must succeed');
    return response.json();
  }
  const start = new Date();
  let diagnostic;
  if (mode === 'retry') {
    diagnostic = await chat(original.content);
    assert.equal(diagnostic.savedOutputs.length, 0, 'The original diagnostic question must not generate SQL');
    assert.equal(await prisma.aiActivityLog.count({where: {sessionId, step: 'model.author', createdAt: {gte: start}}}),
      0, 'The original diagnostic question must not invoke generation');
  }
  const generationStart = new Date();
  const correction = process.env.GENERATION_RETRY_CORRECTION;
  if (mode === 'resolve_review') assert.ok(correction?.trim(), 'A specific review correction is required');
  const result = await chat(mode === 'resolve_review' ? correction :
    'Retry the model generation requested earlier in this chat and save the complete updated SQL file. ' +
    'Use the original supplied model and the business-rule changes I already confirmed. ' +
    'Preserve every original output column, CTE, default, masking expression, literal macro call and configuration ' +
    'except where the requested change requires an edit. Do not merely repeat the error explanation.');
  assert.ok(result.savedOutputs.length, 'The retry must deliver a model');
  const files = await prisma.generatedOutput.findMany({where: {sessionId, messageId: result.assistantMessage.id}});
  assert.ok(files.length, 'The generated file must be persisted in the same chat');
  for (const file of files) {
    assert.ok(file.content.trim().length > 100, 'The model must contain substantive SQL');
    assert.notEqual(file.validation?.status, 'rejected', 'The generated model must pass the draft acceptance gate');
    assert.ok(['passed', 'partial'].includes(file.validation?.static_checks), 'Static SQL checks must run');
    assert.equal(file.validation?.target_database_test, 'required', 'Target database validation remains separate');
  }
  assert.doesNotMatch(result.assistantMessage.content, /no file was saved|Still open after review/,
    'The retry must finish without unresolved reviewer issues');
  const turns = await prisma.aiActivityLog.findMany({where: {sessionId, step: 'turn.complete',
    createdAt: {gte: generationStart}}, select: {turnId: true}});
  console.log(JSON.stringify({agentGraphProductionCheck: 'passed', sessionId, failedTurnId,
    diagnosticMessageId: diagnostic?.assistantMessage.id, assistantMessageId: result.assistantMessage.id,
    generationTurnIds: turns.map(t => t.turnId), files: files.map(f => ({id: f.id, filename: f.filename,
      chars: f.content.length, sha256: createHash('sha256').update(f.content).digest('hex'), validation: f.validation}))}));
}
main().catch(error => {console.error(JSON.stringify({agentGraphProductionCheck: 'failed', sessionId,
  reason: error instanceof assert.AssertionError && !error.generatedMessage ? error.message : error.name}));
  process.exitCode = 1;
}).finally(async () => {
  if (keyId) await prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}});
  await prisma.$disconnect();
});
