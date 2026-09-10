// Executed inside a short-lived task using the deployed backend image/secrets.
const assert = require('node:assert/strict');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { githubAppConfigured, githubAppJwt, githubGet } = require('./dist/services/githubApp.js');
const { githubRouter } = require('./dist/routes/github.js');
const prisma = new PrismaClient();
let server, pendingState;

(async () => {
  assert.equal(githubAppConfigured(), true, 'GitHub App is not configured');
  const app = await githubGet('/app', githubAppJwt());
  assert.equal(String(app.id), process.env.GITHUB_APP_ID, 'App identity mismatch');
  const user = await prisma.user.findUnique({ where: { email: 'sagar@callsphere.ai' } });
  assert.ok(user, 'Requested administrator account is missing');
  assert.equal(user.status, 'active', 'Requested account is not active');
  assert.equal(user.role, 'admin', 'Requested account is not an administrator');

  // Exercise the deployed connection handler with the real account/database.
  // This validates initiation; personal GitHub consent remains the user's step.
  const verificationToken = randomBytes(32).toString('hex');
  // This loopback-only, one-off harness has no cookies or ambient credentials.
  // Every request requires an unguessable bearer token generated in this process.
  // nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage
  const harness = express();
  harness.locals.prisma = prisma;
  harness.use((req, res, next) => {
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${verificationToken}`);
    if (req.headers.origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.sendStatus(401);
    req.user = user; next();
  });
  harness.use('/api/integrations', githubRouter);
  server = harness.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/integrations/github/connect`, {
    method: 'POST', headers: { Authorization: `Bearer ${verificationToken}` },
  });
  assert.equal(response.status, 200, 'Connection initiation failed');
  const authorization = new URL((await response.json()).authorizeUrl);
  pendingState = authorization.searchParams.get('state');
  assert.equal(authorization.origin, 'https://github.com');
  assert.equal(authorization.searchParams.get('client_id'), process.env.GITHUB_CLIENT_ID);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const origin = new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN).origin;
  assert.equal(authorization.searchParams.get('redirect_uri'), `${origin}/api/integrations/github/callback`);
  for (const path of ['/api/integrations', '/api/integrations/github/repositories']) {
    assert.equal((await fetch(origin + path)).status, 401, 'Anonymous integration access must be denied');
  }
  const ping = JSON.stringify({ zen: 'Circini production verification' });
  const signature = 'sha256=' + createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET).update(ping).digest('hex');
  const webhook = origin + '/api/integrations/github/webhook';
  assert.equal((await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping' }, body: ping })).status, 401, 'Unsigned webhook must be rejected');
  assert.equal((await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': signature }, body: ping })).status, 200, 'Signed webhook must be accepted');
  const callback = await fetch(`${origin}/api/integrations/github/callback?state=invalid&code=invalid`, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.ok(callback.headers.get('location').includes('result=expired'));
  console.log(JSON.stringify({ githubProductionCheck: 'passed', app: app.slug, account: { email: user.email, role: user.role, status: user.status },
    connectionInitiation: 'passed', anonymousAccess: 'denied', signedWebhook: 'accepted', unsignedWebhook: 'denied', invalidCallback: 'rejected' }));
})().catch(() => {
  console.error('GitHub production verification failed. Inspect configuration and endpoint status without exposing credentials.');
  process.exitCode = 1;
}).finally(async () => {
  if (pendingState) await prisma.integrationOAuthState.deleteMany({ where: { state: pendingState } });
  if (server) server.close();
  await prisma.$disconnect();
});
