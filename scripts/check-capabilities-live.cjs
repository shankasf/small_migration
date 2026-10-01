// Runs in the deployed backend image. Credentials never leave this process.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {PrismaClient} = require(process.cwd() + '/node_modules/@prisma/client');
const {generateApiKey} = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
let token, userId, otherId, keyId, sessionId, foreignId, phase = 'initialize';
const evidence = {};
function mark(value) {phase = value; console.log(JSON.stringify({capabilitiesProgress: value}));}
async function request(method, path, body, expected = 200, credential = token) {
  const response = await fetch(base + path, {method, headers: {
    'content-type': 'application/json', ...(credential ? {Authorization: `Bearer ${credential}`} : {})},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150000)});
  assert.equal(response.status, expected, `${phase}: HTTP status`);
  return response.status === 204 ? null : response.json();
}
const tool = (name, args = {}, extra = {}, status = 200) => request('POST', `/api/tools/${name}/execute`,
  {sessionId, arguments: args, ...extra}, status);
async function main() {
  const nonce = randomUUID();
  userId = (await prisma.user.create({data: {email: `api-tools-${nonce}@example.test`, role: 'admin'}})).id;
  otherId = (await prisma.user.create({data: {email: `api-tools-other-${nonce}@example.test`, role: 'analyst'}})).id;
  const minted = generateApiKey(); token = minted.key;
  keyId = (await prisma.apiKey.create({data: {userId, name: 'E2E capabilities', prefix: minted.prefix,
    keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 1800000)}})).id;
  mark('hosted Swagger and authenticated catalogues');
  const docs = await fetch(base + '/api-docs/');
  assert.equal(docs.status, 200, 'Swagger reachable');
  assert.ok((await docs.text()).includes('SwaggerUIBundle'), 'Swagger viewer served');
  const spec = await (await fetch(base + '/api-docs/openapi.yaml')).text();
  assert.ok(spec.includes('/api/tools/{toolName}/execute:'), 'Swagger includes tool execution');
  await request('GET', '/api/agents', undefined, 401, '');
  await request('GET', '/api/tools', undefined, 401, '');
  const {agents} = await request('GET', '/api/agents');
  const {tools} = await request('GET', '/api/tools');
  assert.equal(agents.length, 15, 'All agents listed'); assert.equal(tools.length, 12, 'All tools listed');
  for (const t of tools) assert.ok(!('runtime' in t.inputSchema.properties), 'Runtime excluded from schema');
  assert.equal((await request('GET', '/api/agents/repository/tools')).tools.length, 4, 'Repository tool mapping');
  evidence.catalogues = {agents: agents.length, tools: tools.length};
  sessionId = (await request('POST', '/api/sessions', {name: 'E2E API capabilities'}, 201)).id;
  foreignId = (await prisma.session.create({data: {ownerUserId: otherId, name: 'E2E foreign capabilities'}})).id;
  mark('owned files, delivery and search');
  const form = new FormData(); form.append('files', new Blob(['select 731 as value'], {type: 'text/plain'}), 'api_tool_probe.sql');
  const uploaded = await fetch(`${base}/api/files/${sessionId}/upload`, {method: 'POST',
    headers: {Authorization: `Bearer ${token}`}, body: form});
  assert.ok(uploaded.ok, 'Upload succeeded');
  assert.ok((await tool('list_files')).result.includes('api_tool_probe.sql'), 'File tool sees upload');
  const read = await tool('get_file_content', {file_name: 'api_tool_probe.sql'});
  assert.ok(read.ok && read.result.includes('731'), 'Read tool uses actual file content');
  const search = await tool('search_chat_files', {query: 'api_tool_probe.sql', scope: 'current', offset: 0});
  assert.ok(search.ok && search.result.files.length, 'File search uses existing search gateway');
  const asset = search.result.files[0];
  const delivered = await tool('request_file_delivery', {file_id: asset.assetId || asset.id, filename: asset.filename});
  assert.ok(delivered.ok && delivered.result.downloadUrl, 'Delivery produces authenticated URL');
  const download = await fetch(base + delivered.result.downloadUrl, {headers: {Authorization: `Bearer ${token}`}});
  assert.ok(download.ok && (await download.text()).includes('731'), 'Delivered file downloadable');
  assert.ok((await tool('search_chat_history', {query: 'mapping', scope: 'current', offset: 0})).ok, 'Chat history tool works');
  evidence.files = 'list, read, search, delivery and download passed';
  mark('identity, grant and memory boundaries');
  await tool('list_files', {}, {sessionId: foreignId}, 403);
  await tool('list_files', {}, {user_id: otherId}, 400);
  await tool('list_files', {runtime: {}}, {}, 400);
  await tool('read_impact_evidence', {source: 'uploads', operation: 'list'}, {}, 403);
  await prisma.session.update({where: {id: sessionId}, data: {impactState: {
    id: randomUUID(), userId, phase: 'confirmed', sources: ['uploads'], request: 'Synthetic API check', startedAt: new Date().toISOString()}}});
  assert.ok((await tool('read_impact_evidence', {source: 'uploads', operation: 'list'})).ok, 'Persisted source grant works');
  await tool('read_impact_evidence', {source: 'github', operation: 'status'}, {}, 403);
  const memory = {subject: 'API probe schema', fact: 'Use TOOL_TEST_SCHEMA'};
  await tool('remember', memory, {}, 400);
  assert.ok((await tool('remember', memory, {confirm: true})).ok, 'Memory tool writes');
  const memories = await request('GET', `/api/admin/users/${userId}/memory`);
  assert.ok(JSON.stringify(memories).includes('TOOL_TEST_SCHEMA'), 'Memory persisted');
  assert.ok((await tool('forget', {subject: memory.subject}, {confirm: true})).ok, 'Forget tool works');
  evidence.boundaries = 'foreign session, spoofed identity, source grant, explicit memory confirmation passed';
  mark('GitHub tools and audit trail');
  const status = await tool('github_connection_status');
  assert.ok(status.ok && status.result.status === 'not_connected', 'New user has no GitHub connection');
  for (const [name, args] of [['list_github_repositories', {}], ['list_github_files', {}], ['read_github_file', {path: 'model.sql'}]]) {
    const result = await tool(name, args);
    assert.equal(result.ok, false, 'Disconnected GitHub read fails truthfully');
  }
  const audits = await prisma.auditEvent.count({where: {userId, action: 'tool.result'}});
  assert.ok(audits >= 12, 'Tool results audited');
  await prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}});
  await request('GET', '/api/tools', undefined, 401);
  evidence.auditAndRevocation = 'passed';
  console.log(JSON.stringify({capabilitiesProductionCheck: 'passed', evidence}));
}
main().catch(error => {
  console.error(JSON.stringify({capabilitiesProductionCheck: 'failed', phase,
    reason: error instanceof assert.AssertionError && !error.generatedMessage ? error.message : error.name}));
  process.exitCode = 1;
}).finally(async () => {
  if (userId) {
    await fetch(`${process.env.AI_SERVICE_URL}/ai/memory/${userId}`, {method: 'DELETE',
      headers: {'x-internal-key': process.env.INTERNAL_API_KEY}, signal: AbortSignal.timeout(30000)}).catch(() => {});
  }
  if (keyId) await prisma.apiKey.delete({where: {id: keyId}});
  await prisma.session.deleteMany({where: {id: {in: [sessionId, foreignId].filter(Boolean)}}});
  await prisma.user.deleteMany({where: {id: {in: [userId, otherId].filter(Boolean)}}});
  await prisma.$disconnect();
});
