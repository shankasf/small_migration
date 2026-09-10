import { Router, Request, Response, raw } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import axios from 'axios';
import { PrismaClient, Prisma } from '@prisma/client';
import { AuthedRequest, requireWriteAccess } from '../middleware/auth.js';
import { encryptIntegrationSecrets, decryptIntegrationSecrets } from '../services/integrationSecrets.js';
import { recordAudit } from '../services/audit.js';
import { accessibleRepository, githubAppConfigured, githubGet, githubInstallations,
  githubUserToken, installationUrl, tokenSecrets, validGithubSignature } from '../services/githubApp.js';

export const githubRouter = Router();
export const githubCallbackRouter = Router();
export const githubWebhookRouter = Router();
const db = (req: Request): PrismaClient => req.app.locals.prisma;
const origin = () => new URL(process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN || 'http://localhost:5173').origin;
const callbackUrl = () => `${origin()}/api/integrations/github/callback`;
const destination = (result?: string) => `${origin()}/settings?tab=integrations&connect=github${result ? `&provider=github&result=${result}` : ''}`;
const metadata = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, any>;
const positiveId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function fail(res: Response, error: unknown) {
  // Axios errors contain Authorization headers and token-exchange payloads.
  // Report only status codes; never serialize provider request objects.
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  console.error('GitHub request failed', status || 'validation');
  return res.status(status === 401 ? 409 : 400).json({ error: status === 401
    ? 'GitHub authorization expired or was revoked. Please reconnect.'
    : 'GitHub access could not be verified. Refresh the connection and check your repository permissions.' });
}

githubRouter.post('/github/connect', requireWriteAccess, async (req: AuthedRequest, res: Response) => {
  if (!githubAppConfigured()) return res.status(503).json({ error: 'GitHub connection setup is not complete yet.' });
  try {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await db(req).integrationOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await db(req).integrationOAuthState.create({ data: { state, userId: req.user!.id, provider: 'github',
      codeVerifier: verifier, expiresAt: new Date(Date.now() + 10 * 60000) } });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID!, redirect_uri: callbackUrl(), state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    recordAudit(db(req), { userId: req.user!.id, action: 'integration.connect_started', resource: 'github', ip: req.ip });
    res.json({ authorizeUrl: url.toString() });
  } catch (error) { fail(res, error); }
});

githubCallbackRouter.get('/github/callback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Installation redirects are navigation only. Never grant access using the
  // attacker-controlled installation_id; the authenticated API verifies it.
  if (req.query.installation_id && !req.query.state) return res.redirect(destination());
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!state || state.length > 255) return res.redirect(destination('expired'));
  try {
    const prisma = db(req);
    const pending = await prisma.integrationOAuthState.findUnique({ where: { state } });
    if (!pending || pending.provider !== 'github' || pending.expiresAt.getTime() <= Date.now()) return res.redirect(destination('expired'));
    // Atomic consumption prevents simultaneous callbacks from reusing state.
    const consumed = await prisma.integrationOAuthState.deleteMany({ where: { state, provider: 'github', expiresAt: { gt: new Date() } } });
    if (consumed.count !== 1) return res.redirect(destination('expired'));
    const user = await prisma.user.findUnique({ where: { id: pending.userId } });
    if (!user || user.status !== 'active' || user.role === 'auditor') return res.redirect(destination('expired'));
    if (req.query.error || typeof req.query.code !== 'string' || req.query.code.length > 2048) return res.redirect(destination('error'));
    const response = await axios.post('https://github.com/login/oauth/access_token', new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!, client_secret: process.env.GITHUB_CLIENT_SECRET!,
      code: req.query.code, redirect_uri: callbackUrl(), code_verifier: pending.codeVerifier,
    }), { headers: { Accept: 'application/json' }, timeout: 15000 });
    const secrets = tokenSecrets(response.data);
    const profile = await githubGet('/user', secrets.accessToken);
    const installations = await githubInstallations(secrets.accessToken);
    const now = new Date();
    const values = { status: 'connected', displayName: String(profile.login), connectedAt: now, lastVerifiedAt: now,
      metadata: { mode: 'github-app', login: String(profile.login), externalId: String(profile.id),
        avatarUrl: String(profile.avatar_url || ''), profileUrl: String(profile.html_url || '') },
      encryptedSecrets: encryptIntegrationSecrets(secrets) };
    await prisma.integration.upsert({ where: { userId_provider: { userId: user.id, provider: 'github' } },
      create: { userId: user.id, provider: 'github', ...values }, update: values });
    recordAudit(prisma, { userId: user.id, action: 'integration.connected', resource: 'github', ip: req.ip });
    return res.redirect(installations.length ? destination('connected') : installationUrl());
  } catch (error) {
    console.error('GitHub callback failed', axios.isAxiosError(error) ? error.response?.status : 'validation');
    return res.redirect(destination('error'));
  }
});

githubRouter.get('/github/repositories', async (req: AuthedRequest, res) => {
  try {
    const token = await githubUserToken(db(req), req.user!.id);
    const installations = await githubInstallations(token);
    const repositories: any[] = [];
    let truncated = false;
    for (const installation of installations) {
      for (let page = 1; page <= 10; page++) {
        const data = await githubGet(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`, token);
        repositories.push(...data.repositories.map((repo: any) => ({ id: repo.id, installationId: installation.id,
          fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch })));
        if (data.repositories.length < 100) break;
        if (page === 10) truncated = true;
      }
    }
    const row = await db(req).integration.findUnique({ where: { userId_provider: { userId: req.user!.id, provider: 'github' } } });
    const selected = metadata(row?.metadata).selectedRepository || null;
    res.json({ repositories, truncated, installUrl: installationUrl(), selectedRepository: selected,
      installations: installations.map(item => ({ id: item.id, account: item.account.login })) });
  } catch (error) { fail(res, error); }
});

githubRouter.get('/github/branches', async (req: AuthedRequest, res) => {
  const installationId = Number(req.query.installationId), repositoryId = Number(req.query.repositoryId);
  if (!positiveId(installationId) || !positiveId(repositoryId)) return res.status(400).json({ error: 'Choose a repository first.' });
  try {
    const token = await githubUserToken(db(req), req.user!.id);
    const repo = await accessibleRepository(token, installationId, repositoryId);
    const branches: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await githubGet(`/repositories/${repo.id}/branches?per_page=100&page=${page}`, token);
      branches.push(...batch.map((branch: any) => branch.name));
      if (batch.length < 100) break;
    }
    res.json({ branches, defaultBranch: repo.default_branch });
  } catch (error) { fail(res, error); }
});

githubRouter.post('/github/repository', requireWriteAccess, async (req: AuthedRequest, res) => {
  const { installationId, repositoryId, branch } = req.body || {};
  if (!positiveId(installationId) || !positiveId(repositoryId) || typeof branch !== 'string' || !branch || branch.length > 255) {
    return res.status(400).json({ error: 'Choose a repository and branch.' });
  }
  try {
    const prisma = db(req), userId = req.user!.id;
    const token = await githubUserToken(prisma, userId);
    const repo = await accessibleRepository(token, installationId, repositoryId);
    await githubGet(`/repositories/${repo.id}/branches/${encodeURIComponent(branch)}`, token);
    const row = await prisma.integration.findUniqueOrThrow({ where: { userId_provider: { userId, provider: 'github' } } });
    const selectedRepository = { id: repo.id, installationId, fullName: repo.full_name, branch };
    const changed = await prisma.integration.updateMany({ where: { id: row.id, updatedAt: row.updatedAt, status: 'connected' }, data: { lastVerifiedAt: new Date(),
      metadata: { ...metadata(row.metadata), selectedRepository } as Prisma.InputJsonObject } });
    if (changed.count !== 1) return res.status(409).json({ error: 'Your connection changed. Please refresh and try again.' });
    recordAudit(prisma, { userId, action: 'integration.repository_selected', resource: 'github', detail: JSON.stringify(selectedRepository), ip: req.ip });
    res.json({ selectedRepository });
  } catch (error) { fail(res, error); }
});

githubRouter.delete('/github', requireWriteAccess, async (req: AuthedRequest, res) => {
  try {
    const prisma = db(req), userId = req.user!.id;
    const row = await prisma.integration.findUnique({ where: { userId_provider: { userId, provider: 'github' } } });
    if (row) {
      const secrets = decryptIntegrationSecrets(row.encryptedSecrets);
      if (typeof secrets.accessToken === 'string') {
        try {
          await axios.delete(`https://api.github.com/applications/${encodeURIComponent(process.env.GITHUB_CLIENT_ID!)}/token`, {
            auth: { username: process.env.GITHUB_CLIENT_ID!, password: process.env.GITHUB_CLIENT_SECRET! },
            data: { access_token: secrets.accessToken }, headers: { Accept: 'application/vnd.github+json' }, timeout: 15000,
          });
        } catch (error) {
          if (!axios.isAxiosError(error) || ![401, 404, 422].includes(error.response?.status || 0)) throw error;
        }
      }
      await prisma.integration.deleteMany({ where: { userId, provider: 'github' } });
    }
    await prisma.integrationOAuthState.deleteMany({ where: { userId, provider: 'github' } });
    recordAudit(prisma, { userId, action: 'integration.disconnected', resource: 'github', ip: req.ip });
    res.status(204).send();
  } catch (error) { fail(res, error); }
});

// Mount before express.json: signatures must cover the original bytes.
githubWebhookRouter.post('/github/webhook', raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
  if (!process.env.GITHUB_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook setup is incomplete' });
  if (!Buffer.isBuffer(req.body) || !validGithubSignature(req.body, req.headers['x-hub-signature-256'])) return res.status(401).json({ error: 'Invalid signature' });
  let payload: any;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const event = req.headers['x-github-event'];
  try {
    const prisma = db(req);
    if (event === 'github_app_authorization' && payload.action === 'revoked' && payload.sender?.id) {
      const rows = await prisma.integration.findMany({ where: { provider: 'github', metadata: { path: ['externalId'], equals: String(payload.sender.id) } } });
      for (const row of rows) {
        const secrets = decryptIntegrationSecrets(row.encryptedSecrets);
        try {
          // A delayed/replayed revocation must not delete a newer authorization.
          await githubGet('/user', String(secrets.accessToken || ''));
        } catch (error) {
          if (!axios.isAxiosError(error) || error.response?.status !== 401) throw error;
          await prisma.integration.deleteMany({ where: { id: row.id, updatedAt: row.updatedAt } });
        }
      }
    }
    // Never grant access from a webhook. Subsequent API calls always verify
    // current user permissions. Clear a saved selection when access is removed.
    if ((event === 'installation' && ['deleted', 'suspend'].includes(payload.action))
      || (event === 'installation_repositories' && payload.action === 'removed')) {
      const id = payload.installation?.id;
      if (!positiveId(id)) return res.status(400).json({ error: 'Invalid installation' });
      const rows = await prisma.integration.findMany({ where: { provider: 'github', metadata: { path: ['selectedRepository', 'installationId'], equals: id } } });
      for (const row of rows) {
        const previous = metadata(row.metadata);
        if (event === 'installation_repositories' && !payload.repositories_removed?.some((repo: any) => repo.id === previous.selectedRepository?.id)) continue;
        const { selectedRepository: _removed, ...remaining } = previous;
        await prisma.integration.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { metadata: remaining as Prisma.InputJsonObject } });
      }
    }
    return res.json({ ok: true });
  } catch { return res.status(500).json({ error: 'Webhook processing failed' }); }
});
