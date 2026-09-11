// Runs in the deployed backend task. GitHub operations are exclusively reads.
// A temporary application API key is revoked in finally; provider tokens never leave the backend.
const assert = require('node:assert/strict');
const { PrismaClient } = require(process.cwd() + '/node_modules/@prisma/client');
const { generateApiKey } = require(process.cwd() + '/dist/services/apiKeys.js');
const { readGitHub } = require(process.cwd() + '/dist/services/githubAgent.js');
const prisma = new PrismaClient();
const origin = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
const label = 'E2E GitHub read verification';
const email = process.env.GITHUB_VERIFY_EMAIL || 'sagar@callsphere.ai';
let phase = 'initialization', keyId, token, finalEvidence;
function mark(value, detail = {}) { phase = value; console.log(JSON.stringify({ githubAgentProgress: value, ...detail })); }
async function api(endpoint, body, expected = 200) {
  const response = await fetch(origin + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(600000),
  });
  assert.equal(response.status, expected, 'Application request failed'); return response.json();
}
async function main() {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, status: true, role: true } });
  assert.ok(user && user.status === 'active' && user.role === 'admin', 'Exact active administrator not found');
  mark('verify actual connected account and selected branch');
  const context = await readGitHub(prisma, user.id, 'status', {});
  assert.equal(context.status, 'connected'); assert.equal(context.verified, true);
  assert.ok(context.selectedRepository && context.selectedCommitSha, 'Choose a repository and branch before running verification');
  const originalSelection = JSON.stringify(context.selectedRepository);
  const tree = await readGitHub(prisma, user.id, 'tree', {});
  assert.equal(tree.ref, context.selectedRepository.branch);
  const preferredPaths = ['services/backend/package.json', 'package.json', 'dbt_project.yml'];
  const paths = tree.entries.filter(entry => entry.type === 'blob').map(entry => entry.path);
  const filePath = preferredPaths.find(path => paths.includes(path)) || paths.find(path => /\.(sql|ya?ml|json)$/.test(path));
  assert.ok(filePath, 'No suitable text file found for safe repository verification');
  const file = await readGitHub(prisma, user.id, 'file', { path: filePath, ref: tree.commitSha });
  assert.equal(file.commitSha, tree.commitSha); assert.ok(file.content.length);
  let expectedPackageName;
  if (filePath.endsWith('package.json')) expectedPackageName = JSON.parse(file.content).name;
  mark('repository file read verified', { repository: file.repository, branch: tree.ref, commitSha: file.commitSha, path: filePath });
  const key = generateApiKey(); token = key.key;
  const saved = await prisma.apiKey.create({ data: { userId: user.id, name: label, prefix: key.prefix, keyHash: key.keyHash, expiresAt: new Date(Date.now() + 1800000) } });
  keyId = saved.id;
  const internal = await fetch(origin + '/api/internal/github/any-session', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ user_id: user.id, operation: 'status' }) });
  assert.equal(internal.status, 401, 'User credential bypassed internal gateway guard');
  let session;
  if (process.env.GITHUB_VERIFY_SESSION_ID) {
    session = await prisma.session.findUnique({ where: { id: process.env.GITHUB_VERIFY_SESSION_ID }, select: { id: true, ownerUserId: true, name: true } });
    assert.ok(session?.ownerUserId === user.id && session.name.startsWith(label), 'Only an existing labeled verification chat can be resumed; original user chats are preserved');
  } else session = await api('/api/sessions', { name: `${label} ${new Date().toISOString()}` }, 201);
  const started = new Date();
  mark('chat verifies actual GitHub capability', { sessionId: session.id });
  const statusReply = await api(`/api/chat/${session.id}/messages`, {
    message: 'can you access my github',
  });
  assert.ok(statusReply.assistantMessage?.content?.length, 'Capability response missing');
  assert.ok(!/(?:don['’]t|do not) have direct access|cannot access your GitHub|can['’]t access your GitHub/i.test(statusReply.assistantMessage.content), 'Original generic GitHub denial persists');
  const statusEvents = await prisma.aiActivityLog.count({ where: { sessionId: session.id, userId: user.id, createdAt: { gte: started }, step: 'tool.call', tool: 'github_connection_status' } });
  assert.ok(statusEvents > 0, 'Original access question did not verify the live connection');
  mark('chat lists and reads actual selected repository file');
  const readReply = await api(`/api/chat/${session.id}/messages`, {
    message: `For this migration workspace, list my accessible GitHub repositories, list the files using my saved repository and branch, and then read ${filePath} using the commit SHA returned by the listing. Report the selected repository and branch, that path, the full commit SHA, and one concrete fact read from the file; for package.json include its exact package name. Do not change anything, generate files, or create commits.`,
  });
  assert.ok(readReply.assistantMessage?.content?.includes(filePath), 'Assistant omitted actual file path');
  assert.ok(readReply.assistantMessage.content.includes(context.selectedRepository.fullName), 'Assistant omitted verified repository');
  assert.ok(readReply.assistantMessage.content.includes(context.selectedRepository.branch), 'Assistant ignored saved branch');
  assert.ok(readReply.assistantMessage.content.includes(file.commitSha), 'Assistant omitted verified commit provenance');
  if (expectedPackageName) assert.ok(readReply.assistantMessage.content.includes(expectedPackageName), 'Assistant did not report actual package content');
  const events = await prisma.aiActivityLog.findMany({ where: { sessionId: session.id, userId: user.id, createdAt: { gte: started }, step: 'tool.call' }, select: { tool: true } });
  const called = [...new Set(events.map(event => event.tool))];
  for (const name of ['github_connection_status', 'list_github_repositories', 'list_github_files', 'read_github_file']) assert.ok(called.includes(name), `Required real tool call absent: ${name}`);
  const after = await readGitHub(prisma, user.id, 'status', {});
  assert.equal(JSON.stringify(after.selectedRepository), originalSelection, 'Repository selection changed during verification');
  const contentAfter = await readGitHub(prisma, user.id, 'file', { path: filePath, ref: file.commitSha });
  assert.equal(contentAfter.content, file.content, 'Verified repository content changed');
  finalEvidence = { githubAgentProductionCheck: 'passed', userId: user.id, sessionId: session.id,
    repository: file.repository, branch: tree.ref, commitSha: file.commitSha, path: filePath, tools: called, originalChatsUnchanged: true, githubWrites: false };
}
main().catch(() => { console.error(JSON.stringify({ githubAgentProductionCheck: 'failed', phase })); process.exitCode = 1; })
  .finally(async () => {
    try {
      if (keyId) {
        await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
        const revoked = await fetch(origin + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
        assert.equal(revoked.status, 401, 'Revoked test credential still works');
        console.log(JSON.stringify({ githubAgentCredentialRevocation: 'passed', revokedStatus: revoked.status }));
      }
      if (finalEvidence && !process.exitCode) console.log(JSON.stringify({ ...finalEvidence, testCredentialRevoked: true }));
    } catch { console.error(JSON.stringify({ githubAgentCredentialRevocation: 'failed' })); process.exitCode = 1; }
    token = undefined; await prisma.$disconnect();
  });
