// Runs in a one-off deployed backend task. Credentials never leave as plaintext.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PrismaClient } = require(process.cwd() + '/node_modules/@prisma/client');
const { generateApiKey } = require(process.cwd() + '/dist/services/apiKeys.js');
const prisma = new PrismaClient();
const base = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
const browserKeyName = 'E2E file library browser';
const run = `E2E file library ${new Date().toISOString()}`;
let keyId, token, phase = 'initialization';
const evidence = { run, sessions: [] };
function mark(name, detail = {}) {
  phase = name;
  console.log(JSON.stringify({ fileLibraryProgress: name, ...detail }));
}
async function api(path, options = {}, expected = 200) {
  const response = await fetch(base + path, { ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(300000),
  });
  assert.equal(response.status, expected, `${phase}: ${options.method || 'GET'} ${path} status`);
  return response.json();
}
const post = (path, body, expected = 200) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}, expected);
async function session(label) {
  const item = await post('/api/sessions', { name: `${run} ${label}` }, 201);
  evidence.sessions.push(item.id);
  return item.id;
}
async function search(q, kind) {
  return api('/api/files/library?' + new URLSearchParams({ q, ...(kind ? { kind } : {}) }));
}
async function upload(sessionId, filename, content) {
  const form = new FormData();
  form.append('files', new Blob([content], { type: 'text/plain' }), filename);
  return api(`/api/files/${sessionId}/upload`, { method: 'POST', body: form }, 201);
}
async function message(sessionId, text, asset) {
  const result = await post(`/api/chat/${sessionId}/messages`, { message: text, fileRefs: [asset.id] });
  assert.ok(result.assistantMessage?.content?.length, `${phase}: assistant reply missing`);
  const reference = result.userMessage?.fileRefs?.find(ref => ref.assetId === asset.id);
  assert.ok(reference, `${phase}: exact reference missing`);
  assert.equal(reference.version, asset.version, `${phase}: reference version mismatch`);
  assert.equal(reference.sourceSessionId, asset.sessionId || asset.sourceSessionId, `${phase}: source mismatch`);
  const reloaded = await api(`/api/chat/${sessionId}/messages`);
  const messages = Array.isArray(reloaded) ? reloaded : reloaded.messages;
  assert.ok(messages.find(item => item.id === result.userMessage.id)?.fileRefs?.some(ref => ref.assetId === asset.id),
    `${phase}: reference did not survive reload`);
  return result;
}
async function waitFor(label, check, timeout = 600000) {
  const until = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    mark(label);
    await new Promise(resolve => setTimeout(resolve, 15000));
  } while (Date.now() < until);
  throw new Error(`${label}: timed out`);
}
async function main() {
  const revokeId = process.env.FILE_LIBRARY_REVOKE_KEY_ID;
  if (revokeId) {
    phase = 'browser credential revocation';
    const key = await prisma.apiKey.findUnique({ where: { id: revokeId } });
    assert.equal(key?.name, browserKeyName, 'Refusing to revoke a key outside the browser E2E scope');
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    console.log(JSON.stringify({ fileLibraryBrowserKeyRevoked: key.id }));
    return;
  }
  const user = await prisma.user.findUnique({ where: { email: 'sagar@callsphere.ai' } });
  assert.equal(user?.role, 'admin', 'Verification administrator missing');
  assert.equal(user.status, 'active', 'Verification administrator inactive');
  const minted = generateApiKey();
  token = minted.key;
  const key = await prisma.apiKey.create({ data: { userId: user.id, name: run,
    prefix: minted.prefix, keyHash: minted.keyHash, expiresAt: new Date(Date.now() + 3600000) } });
  keyId = key.id;
  const extension = await prisma.$queryRaw`SELECT extversion FROM pg_extension WHERE extname='vector'`;
  assert.equal(extension.length, 1, 'pgvector is not enabled');
  evidence.vectorVersion = extension[0].extversion;
  assert.equal((await fetch(base + '/api/files/library')).status, 401, 'Anonymous library access accepted');
  mark('legacy file selection');
  const existing = await prisma.uploadedFile.findFirst({ where: {
    session: { ownerUserId: user.id, name: { not: { startsWith: 'E2E file library' } } },
  }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  assert.ok(existing, 'An existing owned upload is required for the legacy-file test');
  const legacy = await waitFor('legacy backfill', () => prisma.fileAsset.findFirst({
    where: { kind: 'upload', sourceId: existing.id }, orderBy: { version: 'asc' },
  }));
  evidence.legacyAssetId = legacy.id;
  const source = await session('upload source');
  const target = await session('cross chat reuse');
  const nonce = crypto.randomBytes(6).toString('hex');
  const filename = `library_probe_${nonce}.sql`;
  const v1 = '-- Synthetic daily refund ledger; aggregate returned orders by settlement date.\nSELECT 731 AS library_revision;\n';
  const v2 = '-- Synthetic daily refund ledger; corrected revision.\nSELECT 842 AS library_revision;\n';
  mark('upload and immutable versions');
  await upload(source, filename, v1);
  let found = (await search(filename, 'upload')).files.filter(item => item.sourceSessionId === source);
  assert.equal(found.length, 1, 'First upload snapshot missing');
  const first = found[0];
  await upload(source, filename, v2);
  found = (await search(filename, 'upload')).files.filter(item => item.sourceSessionId === source);
  assert.equal(found.length, 2, 'Reupload did not create a new version');
  assert.equal(new Set(found.map(item => item.id)).size, 2, 'Versions share an asset ID');
  assert.equal((await api(`/api/files/library/${first.id}/content`)).content, v1, 'Original upload changed');
  const second = found.find(item => item.id !== first.id);
  assert.equal((await api(`/api/files/library/${second.id}/content`)).content, v2, 'New upload content mismatch');
  assert.ok(second.version > first.version, 'Upload version did not increase');
  evidence.uploadVersions = found.map(item => ({ id: item.id, version: item.version }));
  const filtered = await api('/api/files/library?' + new URLSearchParams({ q: filename, kind: 'upload',
    from: new Date(Date.now() - 3600000).toISOString(), to: new Date(Date.now() + 60000).toISOString() }));
  assert.ok(filtered.files.some(item => item.id === first.id), 'Date/type filters lost the fixture');
  mark('cross chat exact upload reference');
  const explained = await message(target, 'Read the attached exact SQL version and state its integer library_revision value. Do not generate a file.', first);
  assert.match(explained.assistantMessage.content, /731/, 'AI did not read the selected older upload version');
  mark('generate output from referenced upload');
  const outputName = `library_result_${nonce}.sql`;
  await message(target, `Read the attached exact file. Use generate_output to save a complete Snowflake SQL file named ${outputName} containing exactly SELECT 731 AS library_revision; This synthetic SQL requires no connection. Do not ask for clarification.`, first);
  const outputs = (await search(outputName, 'output')).files.filter(item => item.sourceSessionId === target);
  assert.ok(outputs.length > 0, 'Generated output was not indexed in My Files');
  const output = outputs.sort((a, b) => a.version - b.version)[0];
  const outputContent = await api(`/api/files/library/${output.id}/content`);
  assert.match(outputContent.content, /731/, 'Generated output omitted fixture revision');
  await message(target, `Use generate_output to save a new version of ${outputName} containing exactly SELECT 842 AS library_revision; Keep the same filename. This is a deliberate synthetic revision; do not ask for clarification.`, second);
  const revisedOutputs = (await search(outputName, 'output')).files.filter(item => item.sourceSessionId === target);
  assert.ok(revisedOutputs.some(item => item.id !== output.id && item.version > output.version),
    'Generated revision did not create a separate higher version');
  assert.equal((await api(`/api/files/library/${output.id}/content`)).content, outputContent.content,
    'New output revision overwrote the earlier version');
  const reuse = await session('output and existing file reuse');
  mark('reuse generated output in another chat');
  const reused = await message(reuse, 'Read the attached exact SQL output version. State its integer library_revision value, without generating any files.', output);
  assert.match(reused.assistantMessage.content, /731/, 'AI did not read referenced generated output');
  assert.equal((await api(`/api/files/library/${output.id}/content`)).content, outputContent.content,
    'Generated output changed after reuse');
  evidence.outputAssetId = output.id;
  mark('reuse pre-existing owned file');
  const legacyMatches = await search(legacy.filename, 'upload');
  assert.ok(legacyMatches.files.some(item => item.id === legacy.id), 'Existing file absent from cross-chat search');
  await message(reuse, 'Read this selected existing file and give one concise sentence describing its purpose. Do not change it or generate output.', legacy);
  const foreign = await prisma.fileAsset.findFirst({ where: { session: { ownerUserId: { not: user.id } } } });
  if (foreign) {
    mark('other owner isolation');
    await api(`/api/files/library/${foreign.id}/content`, {}, 403);
    const otherSearch = await search(foreign.filename);
    assert.ok(!otherSearch.files.some(item => item.id === foreign.id), 'Another owner file leaked in search');
    await post(`/api/chat/${reuse}/messages`, { message: 'Read this file.', fileRefs: [foreign.id] }, 403);
    evidence.otherOwnerIsolation = 'passed';
  } else evidence.otherOwnerIsolation = 'no foreign fixture available';
  const expectedAssets = [first.id, second.id, output.id, legacy.id];
  await waitFor('vector indexing', async () => {
    const indexed = await prisma.fileAsset.count({ where: { id: { in: expectedAssets }, indexStatus: 'ready' } });
    return indexed === expectedAssets.length;
  });
  const embedded = await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "FileChunk"
    WHERE "assetId" IN (${first.id},${second.id},${output.id},${legacy.id}) AND embedding IS NOT NULL`;
  assert.ok(embedded[0].count >= expectedAssets.length, 'Vector chunks missing');
  const semantic = await search('daily refund ledger settlement date');
  assert.equal(semantic.semanticAvailable, true, 'Semantic provider unavailable');
  assert.ok(semantic.files.some(item => item.id === first.id), 'Hybrid retrieval did not find synthetic refund ledger');
  evidence.embeddedChunks = embedded[0].count;
  evidence.semanticSearch = 'passed';
  await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  assert.equal((await fetch(base + '/api/files/library', { headers: { Authorization: `Bearer ${token}` } })).status, 401,
    'Revoked verification key still works');
  keyId = undefined;
  token = undefined;
  console.log(JSON.stringify({ fileLibraryProductionCheck: 'passed', ...evidence }));
  if (process.env.BROWSER_PUBLIC_KEY) {
    phase = 'encrypted browser credential';
    const publicKey = crypto.createPublicKey(Buffer.from(process.env.BROWSER_PUBLIC_KEY, 'base64'));
    assert.equal(publicKey.asymmetricKeyType, 'rsa', 'Browser encryption key must be RSA');
    assert.ok(publicKey.asymmetricKeyDetails.modulusLength >= 2048, 'Browser RSA key too short');
    const browser = generateApiKey();
    // Encrypt before persistence, so a bad public key cannot leave an active credential.
    const ciphertext = crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256',
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(browser.key)).toString('base64');
    const browserKey = await prisma.apiKey.create({ data: { userId: user.id, name: browserKeyName,
      prefix: browser.prefix, keyHash: browser.keyHash, expiresAt: new Date(Date.now() + 1200000) } });
    console.log(JSON.stringify({ BROWSER_CREDENTIAL_ENVELOPE: { ciphertext, keyId: browserKey.id,
      expiresAt: browserKey.expiresAt, user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status } } }));
  }
}
main().catch(() => {
  // Do not print response bodies, file contents, credentials, or provider errors.
  console.error(JSON.stringify({ fileLibraryProductionCheck: 'failed', phase }));
  process.exitCode = 1;
}).finally(async () => {
  try { if (keyId) await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } }); }
  catch { console.error('Verification key revocation failed; key expires automatically'); process.exitCode = 1; }
  await prisma.$disconnect();
});
