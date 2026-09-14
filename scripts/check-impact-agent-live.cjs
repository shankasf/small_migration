// Runs inside the deployed backend. Only synthetic evidence and check metadata leave the task.
const assert = require('node:assert/strict');
const {PrismaClient} = require(process.cwd() + '/node_modules/@prisma/client');
const {generateApiKey} = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
let token, keyId, sessionId, phase = 'initialize';
function mark(value) {phase = value; console.log(JSON.stringify({impactProgress: value}));}
async function api(path, body, expected = 200, internal = false) {
  const response = await fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json',
    ...(internal ? {'x-internal-key': process.env.INTERNAL_API_KEY} : {Authorization: `Bearer ${token}`})},
    body: JSON.stringify(body), signal: AbortSignal.timeout(600000)});
  assert.equal(response.status, expected, `${phase}: HTTP status`);
  return response.json();
}
const query = 'What breaks downstream if I rename customer_id to customer_key in stg_customers? Review affected models, columns, tests and dashboards. Do not edit or run anything.';
async function chat(message) {
  const value = await api(`/api/chat/${sessionId}/messages`, {message, fileRefs: []});
  assert.equal(value.savedOutputs.length, 0, 'Impact analysis must never generate or edit files');
  return value.assistantMessage.content;
}
async function state() {return (await prisma.session.findUniqueOrThrow({where: {id: sessionId}})).impactState;}
async function main() {
  const user = await prisma.user.findUniqueOrThrow({where: {email: 'sagar@callsphere.ai'}});
  assert.equal(user.status, 'active');
  const minted = generateApiKey(); token = minted.key;
  const key = await prisma.apiKey.create({data: {userId: user.id, name: 'E2E impact analysis', prefix: minted.prefix,
    keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 3600000)}}); keyId = key.id;
  const session = await api('/api/sessions', {name: `E2E impact analysis ${Date.now()}`}, 201); sessionId = session.id;
  const manifest = {
    metadata: {project_name: 'impact_demo'},
    nodes: {
      'model.impact_demo.stg_customers': {name: 'stg_customers', resource_type: 'model', original_file_path: 'models/stg_customers.sql',
        raw_code: "select customer_id from {{ source('crm', 'customers') }}", depends_on: {nodes: ['source.impact_demo.crm.customers']},
        columns: {customer_id: {name: 'customer_id', description: 'Customer join key'}}},
      'model.impact_demo.customer_mart': {name: 'customer_mart', resource_type: 'model', original_file_path: 'models/customer_mart.sql',
        raw_code: "select customer_id, count(*) as customer_count from {{ ref('stg_customers') }} group by customer_id",
        depends_on: {nodes: ['model.impact_demo.stg_customers']}, columns: {customer_id: {name: 'customer_id'}}},
      'test.impact_demo.not_null_customer_id': {name: 'not_null_customer_id', resource_type: 'test',
        depends_on: {nodes: ['model.impact_demo.stg_customers']}, test_metadata: {name: 'not_null', kwargs: {column_name: 'customer_id'}}},
    },
    sources: {'source.impact_demo.crm.customers': {name: 'customers', source_name: 'crm', resource_type: 'source', columns: {customer_id: {name: 'customer_id'}}}},
    exposures: {'exposure.impact_demo.customer_dashboard': {name: 'customer_dashboard', resource_type: 'exposure', type: 'dashboard',
      depends_on: {nodes: ['model.impact_demo.customer_mart']}}},
  };
  const form = new FormData(); form.append('files', new Blob([JSON.stringify(manifest)], {type: 'application/json'}), 'manifest.json');
  const upload = await fetch(`${base}/api/files/${sessionId}/upload`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: form});
  assert.equal(upload.status, 201);
  mark('confirm sources before any analysis');
  const start = new Date();
  const first = await chat(query);
  assert.match(first, /which evidence sources/i); assert.doesNotMatch(first, /## 2\. Change Summary/);
  const pending = await state(); assert.equal(pending.phase, 'awaiting_sources'); assert.deepEqual(pending.sources, []);
  await api(`/api/internal/impact/${sessionId}`, {user_id: user.id, analysis_id: pending.id, source: 'uploads', operation: 'list', args: {}}, 403, true);
  assert.equal(await prisma.aiActivityLog.count({where: {sessionId, createdAt: {gte: start}, step: 'tool.call', tool: 'read_impact_evidence'}}), 0);
  mark('reject ambiguous confirmation');
  assert.match(await chat('yes'), /which evidence sources/i);
  assert.equal((await state()).phase, 'awaiting_sources');
  mark('delegate confirmed uploads and inspect grounded report');
  const report = await chat('Use uploads');
  const confirmed = await state(); assert.equal(confirmed.phase, 'confirmed'); assert.deepEqual(confirmed.sources, ['uploads']);
  for (const heading of ['Readiness Check', 'Change Summary', 'Hard Evidence Used', 'Likely Impact Level', 'Lineage Summary',
    'Columns to Review', 'Assumptions and Gaps', 'Tests and Documentation to Check', 'Recommended Validation Steps']) assert.ok(report.includes(heading), `Missing section: ${heading}`);
  assert.match(report, /customer_mart/); assert.match(report, /customer_dashboard/); assert.match(report, /Evidence-backed/);
  assert.match(report, /customer_id/); assert.match(report, /stg_customers/);
  const calls = await prisma.aiActivityLog.findMany({where: {sessionId, createdAt: {gte: start}, step: 'tool.call'}, select: {tool: true}});
  assert.ok(calls.some(c => c.tool === 'impact_analysis_agent')); assert.ok(calls.some(c => c.tool === 'read_impact_evidence'));
  assert.ok(!calls.some(c => ['generate_output', 'read_file', 'read_github_file'].includes(c.tool)));
  await api(`/api/internal/impact/${sessionId}`, {user_id: user.id, analysis_id: confirmed.id, source: 'github', operation: 'repositories', args: {}}, 403, true);
  const usage = await prisma.usageRecord.findMany({where: {sessionId}});
  assert.ok(usage.length >= 3, 'Every head/specialist turn must be metered');
  assert.ok(usage.every(u => u.model === 'gpt-6-astra' && u.totalTokens > 0));
  mark('require fresh confirmation for another change');
  const next = await chat('New impact analysis: what breaks if I drop customer_count from customer_mart?');
  assert.match(next, /which evidence sources/i); assert.equal((await state()).phase, 'awaiting_sources');
  assert.equal(await prisma.generatedOutput.count({where: {sessionId}}), 0);
  await prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}}); keyId = null; token = null;
  console.log(JSON.stringify({impactProductionCheck: 'passed', sessionId, model: 'gpt-6-astra',
    sourceConfirmation: 'passed', internalDelegation: 'passed', evidenceScope: 'passed', reportSections: 'passed', readOnly: 'passed'}));
}
main().catch(error => {console.error(JSON.stringify({impactProductionCheck: 'failed', phase, reason: error.code || error.name})); process.exitCode = 1;})
  .finally(async () => {if (keyId) await prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}}); await prisma.$disconnect();});
