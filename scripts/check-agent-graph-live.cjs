// Runs inside the deployed backend. Exercises the LangGraph migration pipeline end to end:
// Requirements Analyst → clarification pause (interrupt) → resume → Model Author → validation →
// Model Reviewer → published file. Only synthetic fixtures and check metadata leave the task.
const assert = require('node:assert/strict');
const {PrismaClient} = require(process.cwd() + '/node_modules/@prisma/client');
const {generateApiKey} = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
const expectedModel = process.env.EXPECTED_LLM_MODEL || 'gpt-6-astra';
const expectedProvider = process.env.EXPECTED_LLM_PROVIDER || 'openai';
let token, keyId, sessionId, phase = 'initialize';
function mark(value) {phase = value; console.log(JSON.stringify({agentGraphProgress: value}));}
// Assertion messages written here are safe to log; a generated one quotes the
// compared values, which may be chat content, so report only a code.
function failureReason(error) {
  return error instanceof assert.AssertionError && error.generatedMessage === false
    ? error.message : (error?.code || error?.name || 'unknown');
}
const FIXTURE_PREFIX = 'E2E agent graph ';
async function purgeFixtures(ownerUserId) {
  const stale = await prisma.session.findMany({where: {ownerUserId, name: {startsWith: FIXTURE_PREFIX}}, select: {id: true}});
  for (const session of stale) await prisma.session.delete({where: {id: session.id}});
  return stale.length;
}
async function api(path, body, expected = 200) {
  const response = await fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json',
    Authorization: `Bearer ${token}`}, body: JSON.stringify(body), signal: AbortSignal.timeout(600000)});
  assert.equal(response.status, expected, `${phase}: HTTP status`);
  return response.json();
}
const chat = message => api(`/api/chat/${sessionId}/messages`, {message, fileRefs: []});
const mapping = ['target_field,source_field,transform,datatype,nullable',
  'policy_id,id,none,NUMBER(38,0),N', "policy_type,type_cd,TRIM default 'NA',VARCHAR(10),N",
  'premium_amt,premium,none,NUMBER(18,2),Y', 'start_dt,start_date,TO_DATE,DATE,Y'].join('\n');
const template = ['field,type,nullable,default', 'policy_id,NUMBER(38,0),N,', 'policy_type,VARCHAR(10),N,NA',
  'premium_amt,NUMBER(18,2),Y,', 'start_dt,DATE,Y,'].join('\n');

async function main() {
  const user = await prisma.user.findUniqueOrThrow({where: {email: 'sagar@callsphere.ai'}});
  assert.equal(user.status, 'active');
  const minted = generateApiKey(); token = minted.key;
  keyId = (await prisma.apiKey.create({data: {userId: user.id, name: 'E2E agent graph', prefix: minted.prefix,
    keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 3600000)}})).id;
  console.log(JSON.stringify({agentGraphProgress: 'clear fixtures from earlier runs', purgedFixtures: await purgeFixtures(user.id)}));
  sessionId = (await api('/api/sessions', {name: `${FIXTURE_PREFIX}${Date.now()}`}, 201)).id;
  const form = new FormData();
  form.append('files', new Blob([mapping], {type: 'text/csv'}), 'policy_mapping.csv');
  form.append('files', new Blob([template], {type: 'text/csv'}), 'policy_template.csv');
  const upload = await fetch(`${base}/api/files/${sessionId}/upload`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: form});
  assert.equal(upload.status, 201);

  mark('analyst asks for the unnamed base model instead of guessing');
  const start = new Date();
  const first = await chat('Generate stg_policies.sql from the attached mapping and template.');
  assert.equal(first.savedOutputs.length, 0, 'A model was generated before the base model was confirmed');
  assert.match(first.assistantMessage.content, /base|ref|source model/i, 'The clarifying question does not ask for the base model');

  mark('the answer resumes the paused thread and produces a reviewed model');
  const second = await chat("Use {{ ref('in_scope_policies') }} as the base model.");
  const file = second.savedOutputs.find(output => /stg_policies\.sql$/.test(output.filename || output.name || ''));
  assert.ok(file, 'stg_policies.sql was not delivered');
  const saved = await prisma.generatedOutput.findFirstOrThrow({where: {sessionId, filename: {endsWith: 'stg_policies.sql'}}});
  assert.match(saved.content, /in_scope_policies/, 'The confirmed base model is not used');
  for (const field of ['policy_id', 'policy_type', 'premium_amt', 'start_dt']) {
    assert.match(saved.content, new RegExp(`\\b${field}\\b`, 'i'), `Mapped field missing: ${field}`);
  }
  assert.doesNotMatch(saved.content, /\b(drop|delete|insert|update|merge|truncate)\b/i, 'Generated SQL is not read-only');

  mark('generate an enrolment error model and verify the actual saved file');
  const errors = await chat("Generate enrolment_errors.sql as a separate new dbt model. All requirements are here; " +
    "the earlier policy mapping does not apply. Read only from {{ ref('enrolment') }}, which has enrolment_id NUMBER, " +
    "nhi VARCHAR, date_from DATE and date_to DATE. Use config(materialized='table', tags=['Enrolment']). " +
    "Return one row per violation, with error_name and all four input fields. Check duplicate date_from per enrolment_id, " +
    "duplicate date_to per nhi, overlapping date ranges for the same nhi but different enrolment_id, " +
    "date_from > date_to, and date_to > DATEADD(month, 11, date_from). Use descriptive error_name values and UNION ALL. " +
    "Compare only non-null dates; ranges overlap inclusively. Give me the complete model SQL and save the file.");
  // Diagnostics before the assertion: a missing file otherwise leaves no trace of
  // how each author attempt ended. Everything here is this check's own fixture.
  const authoring = await prisma.aiActivityLog.findMany({where: {sessionId, step: {in: ['model.author', 'llm.call']},
    createdAt: {gte: new Date(Date.now() - 900000)}}, select: {step: true, message: true, detail: true}, orderBy: {createdAt: 'asc'}});
  console.log(JSON.stringify({agentGraphProgress: 'enrolment diagnostics',
    outputs: errors.savedOutputs.map(output => ({name: output.filename || output.name, validation: output.validation?.status})),
    replyExcerpt: (errors.assistantMessage.content || '').slice(0, 600),
    attempts: authoring.filter(row => row.step === 'model.author').map(row => ({message: (row.message || '').slice(0, 200),
      detail: (row.detail || '').slice(0, 500)})),
    calls: authoring.filter(row => row.step === 'llm.call').slice(-8).map(row => (row.message || '').slice(0, 160))}));
  assert.ok(errors.savedOutputs.some(output => /enrolment_errors\.sql$/.test(output.filename || output.name || '')),
    'The enrolment error model was not delivered');
  const errorFile = await prisma.generatedOutput.findFirstOrThrow({where: {sessionId, filename: {endsWith: 'enrolment_errors.sql'}}});
  for (const field of ['error_name', 'enrolment_id', 'nhi', 'date_from', 'date_to']) {
    assert.match(errorFile.content, new RegExp(`\\b${field}\\b`, 'i'), `Error-model field missing: ${field}`);
  }
  assert.match(errorFile.content, /ref\(\s*['"]enrolment['"]\s*\)/i, 'Error model uses the wrong source');
  assert.match(errorFile.content, /union\s+all/i, 'Error model does not combine validation violations');
  assert.doesNotMatch(errors.assistantMessage.content, /no file was saved|ONE fenced/i, 'Generation reported failure');

  mark('activity log, metering and scope');
  const calls = await prisma.aiActivityLog.findMany({where: {sessionId, createdAt: {gte: start}, step: 'tool.call'}, select: {tool: true}});
  assert.ok(calls.some(c => c.tool === 'generate_output'), 'The published file was not logged');
  assert.ok(!calls.some(c => ['read_impact_evidence', 'impact_analysis_agent'].includes(c.tool)), 'Generation touched impact evidence');
  const modelCalls = await prisma.aiActivityLog.count({where: {sessionId, createdAt: {gte: start}, step: 'llm.call'}});
  assert.ok(modelCalls >= 5, 'Expected router, guard, analyst, author and reviewer model calls');
  const drafts = await prisma.aiActivityLog.findMany({where: {sessionId, createdAt: {gte: start}, step: 'model.author', type: 'info'},
    select: {detail: true}});
  assert.ok(drafts.filter(d => JSON.parse(d.detail || '{}').format === 'structured').length >= 2,
    'Both generated models must use the validated structured draft contract');
  const usage = await prisma.usageRecord.findMany({where: {sessionId}});
  assert.ok(usage.length >= 2 && usage.every(u => u.model === expectedModel && u.provider === expectedProvider && u.totalTokens > 0),
    'Every turn must be metered against the configured model');

  mark('feedback and logs can be traced by chat ID');
  const rating = await fetch(`${base}/api/feedback/messages/${errors.assistantMessage.id}`, {
    method: 'PUT', headers: {'content-type': 'application/json', Authorization: `Bearer ${token}`},
    body: JSON.stringify({rating: 'up', note: 'Synthetic chat ID verification'}),
  });
  assert.equal(rating.status, 200, 'Synthetic feedback was not accepted');
  for (const [path, query] of [['feedback', sessionId], ['feedback', errors.assistantMessage.id], ['ailogs', sessionId]]) {
    const response = await fetch(`${base}/api/admin/${path}?q=${encodeURIComponent(query)}`, {
      headers: {Authorization: `Bearer ${token}`},
    });
    assert.equal(response.status, 200, 'Admin chat ID lookup failed');
    const page = await response.json();
    assert.ok(page.entries.length > 0 && page.entries.every(entry => entry.sessionId === sessionId),
      'ID search did not return only the synthetic chat');
    if (path === 'feedback') assert.ok(page.entries.some(entry => entry.messageId === errors.assistantMessage.id),
      'Feedback omitted the rated message ID');
  }

  await prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}}); keyId = null; token = null;
  await prisma.session.delete({where: {id: sessionId}});
  console.log(JSON.stringify({agentGraphProductionCheck: 'passed', sessionId, model: expectedModel, provider: expectedProvider,
    clarificationPause: 'passed', resume: 'passed', generation: 'passed', enrolmentErrorModel: 'passed',
    structuredDrafts: 'passed', chatIdTraceability: 'passed', metering: 'passed'}));
}
main().catch(error => {console.error(JSON.stringify({agentGraphProductionCheck: 'failed', phase, reason: failureReason(error)})); process.exitCode = 1;})
  .finally(async () => {if (keyId) await prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}}); await prisma.$disconnect();});
