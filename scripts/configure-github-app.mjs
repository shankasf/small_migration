// Production deployment only: credentials enter through a masked Actions secret.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createSign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
const secretId = 'circini/github-oauth';
const aws = args => execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const current = JSON.parse(JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', secretId, '--output', 'json'])).SecretString);
const bootstrap = process.env.GITHUB_APP_BOOTSTRAP_JSON;
const config = bootstrap ? { ...current, ...JSON.parse(bootstrap) } : current;
for (const key of ['appId', 'slug', 'clientId', 'clientSecret', 'privateKey', 'webhookSecret']) {
  if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`GitHub App setup requires ${key}`);
}
if (!/^\d+$/.test(config.appId) || !/^[a-z0-9-]+$/.test(config.slug)) throw new Error('Invalid GitHub App identity');
if (config.webhookSecret.length < 32) throw new Error('Webhook secret must contain at least 32 characters');
if (createPrivateKey(config.privateKey).asymmetricKeyType !== 'rsa') throw new Error('Expected a GitHub RSA private key');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 300, iss: config.clientId })}`;
const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(config.privateKey, 'base64url')}`;
const response = await fetch('https://api.github.com/app', { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } });
if (!response.ok) throw new Error(`GitHub rejected the app key: HTTP ${response.status}`);
const app = await response.json();
if (String(app.id) !== config.appId || app.slug !== config.slug || app.client_id !== config.clientId) throw new Error('GitHub App credentials do not match');
if (app.permissions.contents !== 'read' || Object.values(app.permissions).some(value => value === 'write')) throw new Error('Expected a read-only GitHub App');
// This deliberately invalid code checks the client without using a user's code.
const exchange = await fetch('https://github.com/login/oauth/access_token', { method: 'POST',
  headers: { Accept: 'application/json' }, body: new URLSearchParams({ client_id: config.clientId,
    client_secret: config.clientSecret, code: 'circini-configuration-check-invalid-code' }) });
const result = await exchange.json();
if (result.error !== 'bad_verification_code') throw new Error('GitHub client credentials could not be validated');
if (bootstrap) {
  const dir = mkdtempSync(join(tmpdir(), 'circini-github-'));
  try {
    const path = join(dir, 'credentials.json');
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    aws(['secretsmanager', 'put-secret-value', '--secret-id', secretId, '--secret-string', `file://${path}`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`GitHub App ${app.slug} (${app.id}): credentials verified; production secret ready.`);
}

main().catch(() => {
  // Parser, crypto, or subprocess exceptions can contain input fragments.
  console.error('GitHub App preflight failed. Check AWS access and the appId, slug, clientId, clientSecret, privateKey, and webhookSecret fields. No backend rollout was started.');
  process.exitCode = 1;
});
