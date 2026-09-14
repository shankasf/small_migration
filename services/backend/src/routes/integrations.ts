import { snowflakeKeyPairJwt } from '../services/snowflakeAuth.js';
import { Router, Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import axios from 'axios';
import { Prisma, PrismaClient } from '@prisma/client';
import { AuthedRequest, requireWriteAccess } from '../middleware/auth.js';
import { githubAppConfigured } from '../services/githubApp.js';
import { recordAudit } from '../services/audit.js';
import {
  encryptIntegrationSecrets,
  integrationEncryptionConfigured,
} from '../services/integrationSecrets.js';

type Provider = 'github' | 'gitlab' | 'snowflake' | 'dbt';

const PROVIDERS: Provider[] = ['github', 'gitlab', 'snowflake', 'dbt'];
const privateRouter = Router();
const callbackRouter = Router();

const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;
const isProvider = (value: string): value is Provider => PROVIDERS.includes(value as Provider);

function appOrigin(): string {
  const raw = process.env.PUBLIC_APP_URL || process.env.CORS_ORIGIN || 'http://localhost:5173';
  return new URL(raw).origin;
}

function callbackUrl(provider: 'github' | 'gitlab'): string {
  return `${appOrigin()}/api/integrations/${provider}/callback`;
}

function oauthConfigured(provider: 'github' | 'gitlab'): boolean {
  const prefix = provider.toUpperCase();
  return Boolean(
    process.env[`${prefix}_CLIENT_ID`] &&
    process.env[`${prefix}_CLIENT_SECRET`] &&
    integrationEncryptionConfigured()
  );
}

function providerConfigured(provider: Provider): boolean {
  if (provider === 'github') return githubAppConfigured();
  if (provider === 'gitlab') return oauthConfigured(provider);
  return integrationEncryptionConfigured();
}

function safeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function integrationView(provider: Provider, integration?: {
  status: string;
  displayName: string | null;
  metadata: unknown;
  connectedAt: Date;
  lastVerifiedAt: Date | null;
}) {
  return {
    provider,
    status: integration?.status === 'connected' ? 'connected' : 'disconnected',
    configured: providerConfigured(provider),
    displayName: integration?.displayName ?? null,
    metadata: integration ? safeMetadata(integration.metadata) : {},
    connectedAt: integration?.connectedAt?.toISOString() ?? null,
    lastVerifiedAt: integration?.lastVerifiedAt?.toISOString() ?? null,
  };
}

function cleanText(value: unknown, max = 255): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}


function integrationError(res: Response, error: unknown, fallback: string) {
  const message = axios.isAxiosError(error)
    ? cleanText(error.response?.data?.message || error.response?.data?.error || error.message, 300)
    : error instanceof Error ? error.message : fallback;
  return res.status(400).json({ error: message || fallback });
}

async function upsertIntegration(
  prisma: PrismaClient,
  userId: string,
  provider: Provider,
  displayName: string,
  metadata: Record<string, unknown>,
  secrets: Record<string, unknown>,
) {
  const now = new Date();
  return prisma.integration.upsert({
    where: { userId_provider: { userId, provider } },
    create: {
      userId,
      provider,
      status: 'connected',
      displayName,
      metadata: metadata as Prisma.InputJsonObject,
      encryptedSecrets: encryptIntegrationSecrets(secrets),
      connectedAt: now,
      lastVerifiedAt: now,
    },
    update: {
      status: 'connected',
      displayName,
      metadata: metadata as Prisma.InputJsonObject,
      encryptedSecrets: encryptIntegrationSecrets(secrets),
      connectedAt: now,
      lastVerifiedAt: now,
    },
  });
}

privateRouter.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const rows = await prisma.integration.findMany({ where: { userId: req.user!.id } });
    const byProvider = new Map(rows.map(row => [row.provider, row]));
    res.json({
      integrations: PROVIDERS.map(provider => integrationView(provider, byProvider.get(provider))),
    });
  } catch (error) {
    console.error('Failed to list integrations:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to load integrations' });
  }
});

privateRouter.post('/:provider/connect', requireWriteAccess, async (req: AuthedRequest, res: Response) => {
  const providerName = req.params.provider;
  if (!isProvider(providerName)) return res.status(404).json({ error: 'Unknown integration' });

  if (!providerConfigured(providerName)) {
    return res.status(503).json({
      error: providerName === 'github' || providerName === 'gitlab'
        ? `${providerName === 'github' ? 'GitHub' : 'GitLab'} OAuth is not configured by an administrator`
        : 'Secure integration credential storage is not configured by an administrator',
    });
  }

  if (providerName === 'github' || providerName === 'gitlab') {
    try {
      const prisma = getPrisma(req);
      const state = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(48).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      await prisma.integrationOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await prisma.integrationOAuthState.create({
        data: {
          state,
          userId: req.user!.id,
          provider: providerName,
          codeVerifier,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      const prefix = providerName.toUpperCase();
      const authorize = new URL(
        providerName === 'github'
          ? 'https://github.com/login/oauth/authorize'
          : 'https://gitlab.com/oauth/authorize'
      );
      authorize.searchParams.set('client_id', process.env[`${prefix}_CLIENT_ID`]!);
      authorize.searchParams.set('redirect_uri', callbackUrl(providerName));
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('code_challenge', codeChallenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      authorize.searchParams.set(
        'scope',
        providerName === 'github'
          ? (process.env.GITHUB_OAUTH_SCOPES || 'read:user')
          : (process.env.GITLAB_OAUTH_SCOPES || 'read_user')
      );

      await recordAudit(prisma, {
        userId: req.user!.id,
        action: 'integration.connect_started',
        resource: providerName,
        ip: req.ip,
      });
      return res.json({ authorizeUrl: authorize.toString() });
    } catch (error) {
      console.error('Failed to start integration OAuth:', providerName, error);
      return res.status(500).json({ error: 'Failed to start authorization' });
    }
  }

  if (providerName === 'dbt') {
    const accountId = cleanText(req.body?.accountId, 80);
    const token = cleanText(req.body?.token, 4096);
    const hostInput = cleanText(req.body?.host, 255) || 'cloud.getdbt.com';
    if (!accountId || !/^\d+$/.test(accountId) || !token) {
      return res.status(400).json({ error: 'A numeric account ID and service token are required' });
    }
    const host = hostInput.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (host !== 'cloud.getdbt.com') {
      return res.status(400).json({ error: 'This deployment currently supports cloud.getdbt.com' });
    }

    try {
      const response = await axios.get(`https://${host}/api/v2/accounts/${accountId}/`, {
        headers: { Authorization: `Token ${token}` },
        timeout: 15000,
      });
      const accountName = cleanText(response.data?.data?.name, 180) || `Account ${accountId}`;
      const prisma = getPrisma(req);
      const row = await upsertIntegration(
        prisma,
        req.user!.id,
        'dbt',
        accountName,
        { accountId, host },
        { token },
      );
      await recordAudit(prisma, {
        userId: req.user!.id,
        action: 'integration.connected',
        resource: 'dbt',
        detail: JSON.stringify({ accountId, host }),
        ip: req.ip,
      });
      return res.json({ integration: integrationView('dbt', row) });
    } catch (error) {
      console.error('dbt connection validation failed:', axios.isAxiosError(error) ? error.response?.status : error);
      return integrationError(res, error, 'Could not validate the dbt connection');
    }
  }

  const account = cleanText(req.body?.account, 255);
  const username = cleanText(req.body?.username, 255);
  const privateKey = cleanText(req.body?.privateKey, 16000);
  const privateKeyPass = cleanText(req.body?.privateKeyPass, 2048);
  const warehouse = cleanText(req.body?.warehouse, 255);
  const database = cleanText(req.body?.database, 255);
  const role = cleanText(req.body?.role, 255);
  if (!account || !username || !privateKey) {
    return res.status(400).json({ error: 'Account identifier, username, and private key are required' });
  }
  if (!/^[a-z0-9._-]+$/i.test(account)) {
    return res.status(400).json({ error: 'Enter a valid Snowflake account identifier' });
  }

  try {
    const jwt = snowflakeKeyPairJwt(account, username, privateKey, privateKeyPass || undefined);
    await axios.post(`https://${account.toLowerCase()}.snowflakecomputing.com/api/v2/statements`, {
      statement: 'select current_account(), current_user()',
      timeout: 15,
      ...(warehouse ? { warehouse } : {}),
      ...(database ? { database } : {}),
      ...(role ? { role } : {}),
    }, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'CirciniMigrationAgent/1.0',
        'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
      },
      timeout: 20000,
    });

    const prisma = getPrisma(req);
    const row = await upsertIntegration(
      prisma,
      req.user!.id,
      'snowflake',
      account,
      { account, username, warehouse: warehouse || null, database: database || null, role: role || null },
      { privateKey, privateKeyPass: privateKeyPass || null },
    );
    await recordAudit(prisma, {
      userId: req.user!.id,
      action: 'integration.connected',
      resource: 'snowflake',
      detail: JSON.stringify({ account, username, warehouse, database, role }),
      ip: req.ip,
    });
    return res.json({ integration: integrationView('snowflake', row) });
  } catch (error) {
    console.error('Snowflake connection validation failed:', error instanceof Error ? error.message : error);
    return integrationError(res, error, 'Could not validate the Snowflake connection');
  }
});

privateRouter.delete('/:provider', requireWriteAccess, async (req: AuthedRequest, res: Response) => {
  const providerName = req.params.provider;
  if (!isProvider(providerName)) return res.status(404).json({ error: 'Unknown integration' });
  try {
    const prisma = getPrisma(req);
    await prisma.integration.deleteMany({ where: { userId: req.user!.id, provider: providerName } });
    await recordAudit(prisma, {
      userId: req.user!.id,
      action: 'integration.disconnected',
      resource: providerName,
      ip: req.ip,
    });
    res.status(204).send();
  } catch (error) {
    console.error('Failed to disconnect integration:', providerName);
    res.status(500).json({ error: 'Failed to disconnect integration' });
  }
});

callbackRouter.get('/:provider/callback', async (req: Request, res: Response) => {
  const providerName = req.params.provider;
  const stateValue = cleanText(req.query.state, 255);
  const code = cleanText(req.query.code, 2048);
  const destination = new URL('/settings', appOrigin());
  destination.searchParams.set('tab', 'integrations');

  if ((providerName !== 'github' && providerName !== 'gitlab') || !stateValue || !code) {
    destination.searchParams.set('result', 'error');
    return res.redirect(destination.toString());
  }

  const provider = providerName as 'github' | 'gitlab';
  destination.searchParams.set('provider', provider);
  try {
    const prisma = getPrisma(req);
    const oauthState = await prisma.integrationOAuthState.findUnique({ where: { state: stateValue } });
    if (!oauthState || oauthState.provider !== provider || oauthState.expiresAt.getTime() < Date.now()) {
      if (oauthState) await prisma.integrationOAuthState.delete({ where: { state: stateValue } });
      destination.searchParams.set('result', 'expired');
      return res.redirect(destination.toString());
    }
    await prisma.integrationOAuthState.delete({ where: { state: stateValue } });
    const user = await prisma.user.findUnique({where: {id: oauthState.userId}});
    if (!user || user.status !== 'active' || user.role === 'auditor'
        || (user.tokensValidAfter && oauthState.createdAt <= user.tokensValidAfter)) {
      destination.searchParams.set('result', 'expired');
      return res.redirect(destination.toString());
    }

    const prefix = provider.toUpperCase();
    const tokenUrl = provider === 'github'
      ? 'https://github.com/login/oauth/access_token'
      : 'https://gitlab.com/oauth/token';
    const tokenResponse = await axios.post(tokenUrl, new URLSearchParams({
      client_id: process.env[`${prefix}_CLIENT_ID`]!,
      client_secret: process.env[`${prefix}_CLIENT_SECRET`]!,
      code,
      redirect_uri: callbackUrl(provider),
      grant_type: 'authorization_code',
      code_verifier: oauthState.codeVerifier,
    }), {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    });
    const accessToken = cleanText(tokenResponse.data?.access_token, 4096);
    if (!accessToken) throw new Error('Provider did not return an access token');

    const profileResponse = await axios.get(
      provider === 'github' ? 'https://api.github.com/user' : 'https://gitlab.com/api/v4/user',
      {
        headers: provider === 'github'
          ? { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' }
          : { Authorization: `Bearer ${accessToken}` },
        timeout: 15000,
      }
    );
    const profile = profileResponse.data || {};
    const login = cleanText(profile.login || profile.username || profile.name, 180) || provider;
    await upsertIntegration(
      prisma,
      oauthState.userId,
      provider,
      login,
      {
        login,
        externalId: String(profile.id || ''),
        avatarUrl: cleanText(profile.avatar_url, 1000) || null,
        profileUrl: cleanText(profile.html_url || profile.web_url, 1000) || null,
        scope: cleanText(tokenResponse.data?.scope, 1000),
      },
      {
        accessToken,
        refreshToken: cleanText(tokenResponse.data?.refresh_token, 4096) || null,
        expiresIn: tokenResponse.data?.expires_in || null,
      },
    );
    await recordAudit(prisma, {
      userId: oauthState.userId,
      action: 'integration.connected',
      resource: provider,
      detail: JSON.stringify({ login }),
      ip: req.ip,
    });
    destination.searchParams.set('result', 'connected');
    return res.redirect(destination.toString());
  } catch (error) {
    console.error('Integration OAuth callback failed:', provider, axios.isAxiosError(error) ? error.response?.status : error);
    destination.searchParams.set('result', 'error');
    return res.redirect(destination.toString());
  }
});

export { privateRouter as integrationsRouter, callbackRouter as integrationCallbackRouter };
