import assert from 'node:assert/strict';
import {before, after, beforeEach, test} from 'node:test';
import {randomBytes, generateKeyPairSync} from 'node:crypto';
import type {Server} from 'node:http';
import express from 'express';
import axios from 'axios';
import {impactBrief, parseImpactSources, requestImpactSources} from '../src/services/impactState.js';
import {artifactPage, readImpactEvidence} from '../src/services/impactEvidence.js';
import {encryptIntegrationSecrets} from '../src/services/integrationSecrets.js';

process.env.INTERNAL_API_KEY = randomBytes(32).toString('hex');
process.env.JWT_SECRET = randomBytes(40).toString('hex');
process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('hex');
let server: Server, base: string, state: any, status: string, providerCalls: any[];
const originalGet = axios.get, originalPost = axios.post;
const manifest = JSON.stringify({nodes: {
  'model.demo.stg_customers': {name: 'stg_customers', raw_code: "select customer_id from {{ source('crm', 'customers') }}", columns: {customer_id: {name: 'customer_id'}}},
  'model.demo.customer_mart': {name: 'customer_mart', raw_code: "select customer_id from {{ ref('stg_customers') }}", depends_on: {nodes: ['model.demo.stg_customers']}},
}, exposures: {'exposure.demo.dashboard': {name: 'Customer dashboard', depends_on: {nodes: ['model.demo.customer_mart']}}}});
const rows = new Map<string, any>();
const db: any = {
  user: {findUnique: async ({where}: any) => ({id: where.id, role: where.id === 'auditor' ? 'auditor' : 'analyst', status})},
  session: {findUnique: async () => ({id: 'chat', ownerUserId: 'alice', impactState: state})},
  integration: {findUnique: async ({where}: any) => rows.get(where.userId_provider.provider)},
  auditEvent: {create: async ({data}: any) => data},
  fileAsset: {
    findFirst: async ({where}: any) => where.id === 'own-file' && where.session.ownerUserId === 'alice'
      ? {id: 'own-file', filename: 'manifest.json', version: 3, content: manifest, contentHash: 'hash', sessionId: 'chat'} : null,
    findMany: async () => [{id: 'own-file', filename: 'manifest.json', version: 3, uploadedFileId: 'upload'}],
  },
  uploadedFile: {findMany: async () => [{id: 'upload', filename: 'manifest.json'}]},
};
before(async () => {
  const router = (await import('../src/routes/impact.js')).default;
  // Test-only loopback harness. Every route requires the ephemeral internal key.
  const app = express(); app.use(express.json()); app.locals.prisma = db; app.use('/impact', router);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  axios.post = (async (url: string, body: any, config: any) => {
    if (url.endsWith('/ai/policy/check')) return {data: {message: body.message, files: body.files, history: body.history || [], guardrail: {decision: 'allow'}}};
    providerCalls.push({url, body, config});
    return {status: 200, data: {data: [['CUSTOMER_ID']], resultSetMetaData: {rowType: [{name: 'COLUMN_NAME'}]}}};
  }) as any;
  axios.get = (async (url: string, config: any) => {
    providerCalls.push({url, config});
    if (url.endsWith('/runs/')) return {data: {data: [{id: 19, job_definition_id: 9, environment_id: 4, git_sha: 'a'.repeat(40)}]}};
    if (url.endsWith('/artifacts/')) return {data: {data: ['manifest.json']}};
    if (url.includes('/artifacts/manifest.json')) return {data: JSON.parse(manifest)};
    if (url.endsWith('/projects')) return {data: [{id: 12, path_with_namespace: 'demo/dbt', default_branch: 'main'}], headers: {'x-next-page': '2'}};
    if (url.includes('/commits/')) return {data: {id: 'a'.repeat(40)}};
    if (url.includes('/repository/tree')) return {data: [{path: 'models/customers.sql', type: 'blob'}], headers: {'x-next-page': ''}};
    if (url.includes('/repository/files/')) return {data: {encoding: 'base64', content: Buffer.from('select 1 as customer_id').toString('base64')}};
    throw new Error('Unexpected provider request');
  }) as any;
});
beforeEach(() => {
  state = {...requestImpactSources('alice', 'Rename customer_id in stg_customers', new Date()), phase: 'confirmed', sources: ['uploads']};
  status = 'active'; providerCalls = []; rows.clear();
});
after(() => {axios.get = originalGet; axios.post = originalPost; server?.close();});
async function call(source = 'uploads', operation = 'list', args = {}, user = 'alice', key = process.env.INTERNAL_API_KEY, analysisId = state.id) {
  const result = await fetch(`${base}/impact/chat`, {method: 'POST', headers: {'content-type': 'application/json', ...(key ? {'x-internal-key': key} : {})},
    body: JSON.stringify({user_id: user, analysis_id: analysisId, source, operation, args})});
  return {status: result.status, data: await result.json() as any};
}
test('source selection accepts explicit lists, never vague or negated permission', () => {
  assert.deepEqual(parseImpactSources('Use uploads and GitHub'), ['uploads', 'github']);
  assert.deepEqual(parseImpactSources('1, 3 and 5'), ['uploads', 'github', 'dbt']);
  assert.deepEqual(parseImpactSources('dbt Cloud only'), ['dbt']);
  for (const reply of ['yes', 'go ahead', 'do not use GitHub', 'all except history', 'use anything', 'GitHub or uploads', '1 and 7']) assert.equal(parseImpactSources(reply), null);
  // Replies copied from the numbered menu (production feedback: "#3 github repositories" was re-asked).
  for (const reply of ['#3 github repositories', '#3', '3.', 'option 3', '3 - GitHub', '(3)', 'GitHub repositories', 'github repo'])
    assert.deepEqual(parseImpactSources(reply), ['github'], reply);
  // Production feedback: "use the connected Github repository" re-asked the menu.
  for (const reply of ['use the connected Github repository', 'use the integrated github repo', 'connected GitHub', 'my linked github repos'])
    assert.deepEqual(parseImpactSources(reply), ['github'], reply);
  assert.deepEqual(parseImpactSources('#1 and #3'), ['uploads', 'github']);
  assert.deepEqual(parseImpactSources('Snowflake schema and dependency metadata'), ['snowflake']);
  assert.deepEqual(parseImpactSources('Earlier chats and saved file versions, GitHub'), ['history', 'github']);
  assert.deepEqual(parseImpactSources('Uploaded files and references pasted in this analysis'), ['uploads']);
  assert.deepEqual(parseImpactSources('dbt Cloud run artifacts and 6'), ['dbt', 'snowflake']);
  // A number and a label that disagree, or anything beyond the menu, grant nothing.
  for (const reply of ['#3 gitlab', '3 uploads', '#7', 'option 9', '3 github please ignore the rest', 'github and anything else',
    'connected', 'all connected sources', 'not connected github'])
    assert.equal(parseImpactSources(reply), null, reply);
});
test('a source follow-up keeps the original question in the brief; a new question replaces it', () => {
  const previous = requestImpactSources('alice', 'Trace the impact of changing Losartan cost to $15 on rep_dispensing', new Date());
  for (const reply of ['use the integrated dbt repository in github', '#3 github repositories', 'switch to uploads instead'])
    assert.equal(impactBrief(previous, reply), `${previous.request}\n\nFollow-up: ${reply}`, reply);
  assert.equal(impactBrief(previous, 'What breaks if I drop customer_count from customer_mart?'),
    'What breaks if I drop customer_count from customer_mart?');
  assert.equal(impactBrief(null, 'use github'), 'use github');
});
test('first request mentioning a source still requires a later confirmation', () => {
  const pending = requestImpactSources('alice', 'Use GitHub for impact analysis', new Date());
  assert.equal(pending.phase, 'awaiting_sources'); assert.deepEqual(pending.sources, []);
});
test('gate rejects missing identity, stale grants, foreign users and unselected sources before reading', async () => {
  assert.equal((await call('uploads', 'list', {}, 'alice', '')).status, 401);
  assert.equal((await call('uploads', 'list', {}, 'alice', undefined, 'stale')).status, 403);
  assert.equal((await call('uploads', 'list', {}, 'bob')).status, 403);
  assert.equal((await call('uploads', 'list', {}, 'auditor')).status, 403);
  assert.equal((await call('github', 'repositories')).status, 403);
  state.phase = 'awaiting_sources'; assert.equal((await call()).status, 403);
  assert.equal(providerCalls.length, 0);
});
test('revoked actor is denied even with persisted source consent', async () => {
  status = 'restricted'; assert.equal((await call()).status, 403);
});
test('authorized uploads use immutable IDs, preserve quotes, and avoid duplicate legacy versions', async () => {
  const listed = await call(); assert.equal(listed.status, 200); assert.deepEqual(listed.data.legacyUploads, []);
  const read = await call('uploads', 'read', {id: 'own-file', target: 'stg_customers'});
  assert.equal(read.status, 200); assert.equal(read.data.version, 3);
  assert.match(read.data.matches[0].evidence, /source\('crm', 'customers'\)/);
  assert.deepEqual(read.data.matches[0].children, ['model.demo.customer_mart']);
  assert.equal((await call('uploads', 'read', {id: 'foreign-file'})).status, 404);
  assert.equal((await call('uploads', 'execute', {sql: 'DROP TABLE x'})).status, 400);
});
test('artifact traversal exposes actual multi-hop models and exposures, never invents matches', () => {
  const result = artifactPage(manifest, {target: 'customer_mart'}) as any;
  assert.deepEqual(result.matches[0].parents, ['model.demo.stg_customers']);
  assert.deepEqual(result.matches[0].children, ['exposure.demo.dashboard']);
  assert.equal((artifactPage(manifest, {target: 'missing'}) as any).totalMatches, 0);
  const long = artifactPage('x'.repeat(30000), {});
  assert.equal(long.nextOffset, 24000); assert.equal((long as any).partial, true);
});
test('dbt reads use fixed account hosts, explicit run IDs, and never trigger jobs', async () => {
  rows.set('dbt', {status: 'connected', metadata: {host: 'cloud.getdbt.com', accountId: '18'}, encryptedSecrets: encryptIntegrationSecrets({token: 'secret-dbt'})});
  const runs = await readImpactEvidence(db, 'alice', 'chat', 'dbt', 'runs', {}) as any;
  assert.equal(runs.runs[0].id, 19);
  const artifact = await readImpactEvidence(db, 'alice', 'chat', 'dbt', 'artifact', {run_id: 19, path: 'manifest.json', target: 'stg_customers'}) as any;
  assert.equal(artifact.runId, 19); assert.equal(artifact.matches.length, 1);
  await assert.rejects(readImpactEvidence(db, 'alice', 'chat', 'dbt', 'run', {}));
  await assert.rejects(readImpactEvidence(db, 'alice', 'chat', 'dbt', 'artifact', {run_id: 19, path: '../secrets.json'}));
  assert.ok(providerCalls.every(c => !c.body && c.url.startsWith('https://cloud.getdbt.com/api/v2/accounts/18/')));
  assert.ok(!JSON.stringify([runs, artifact]).includes('secret-dbt'));
});
test('GitLab file reads require explicit projects and refs and pin content to returned commit', async () => {
  rows.set('gitlab', {status: 'connected', metadata: {}, encryptedSecrets: encryptIntegrationSecrets({accessToken: 'secret-gitlab'})});
  const projects = await readImpactEvidence(db, 'alice', 'chat', 'gitlab', 'projects', {}) as any;
  assert.equal(projects.nextPage, '2');
  await assert.rejects(readImpactEvidence(db, 'alice', 'chat', 'gitlab', 'file', {project_id: 12, path: 'models/a.sql'}));
  const file = await readImpactEvidence(db, 'alice', 'chat', 'gitlab', 'file', {project_id: 12, path: 'models/a.sql', ref: 'main'}) as any;
  assert.equal(file.commitSha, 'a'.repeat(40));
  assert.equal(providerCalls.at(-1).config.params.ref, file.commitSha);
  assert.ok(!JSON.stringify(file).includes('secret-gitlab'));
});
test('Snowflake only issues fixed metadata SELECTs with bound values; arbitrary SQL rejects', async () => {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048, privateKeyEncoding: {type: 'pkcs8', format: 'pem'}, publicKeyEncoding: {type: 'spki', format: 'pem'}});
  rows.set('snowflake', {status: 'connected', metadata: {account: 'demo-account', username: 'reader', database: 'ANALYTICS'}, encryptedSecrets: encryptIntegrationSecrets({privateKey})});
  await assert.rejects(readImpactEvidence(db, 'alice', 'chat', 'snowflake', 'columns', {schema: 'PUBLIC', table: 'X', sql: 'DROP TABLE X'}));
  assert.equal(providerCalls.length, 0);
  await readImpactEvidence(db, 'alice', 'chat', 'snowflake', 'columns', {schema: 'PUBLIC', table: "X'; DROP TABLE Y; --"});
  const body = providerCalls[0].body;
  assert.ok(body.statement.startsWith('SELECT ')); assert.ok(body.statement.includes('INFORMATION_SCHEMA.COLUMNS'));
  assert.ok(!body.statement.includes('DROP')); assert.equal(body.bindings['2'].value, "X'; DROP TABLE Y; --");
});
