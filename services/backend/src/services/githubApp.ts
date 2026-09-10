import { createHmac, createPrivateKey, createSign, timingSafeEqual } from 'node:crypto';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { decryptIntegrationSecrets, encryptIntegrationSecrets, integrationEncryptionConfigured } from './integrationSecrets.js';

export function githubAppConfigured(): boolean {
  try {
    return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      && /^[a-z0-9-]+$/.test(process.env.GITHUB_APP_SLUG || '')
      && createPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY || '').asymmetricKeyType === 'rsa'
      && integrationEncryptionConfigured());
  } catch { return false; }
}

export function githubAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60, exp: now + 300, iss: process.env.GITHUB_CLIENT_ID,
  })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(process.env.GITHUB_APP_PRIVATE_KEY!, 'base64url')}`;
}

export function githubHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

export function validGithubSignature(body: Buffer, signature: unknown, secret = process.env.GITHUB_WEBHOOK_SECRET): boolean {
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function tokenSecrets(data: Record<string, unknown>) {
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('GitHub authorization failed');
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null,
    refreshExpiresAt: typeof data.refresh_token_expires_in === 'number' ? Date.now() + data.refresh_token_expires_in * 1000 : null,
  };
}

// Serialize rotating refresh tokens across backend replicas. Tokens never leave
// the server, and every query starts from the authenticated application user.
export async function githubUserToken(prisma: PrismaClient, userId: string): Promise<string> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Integration" WHERE "userId" = ${userId} AND provider = 'github' FOR UPDATE`;
    const row = await tx.integration.findUnique({ where: { userId_provider: { userId, provider: 'github' } } });
    if (!row || row.status !== 'connected') throw new Error('Connect your GitHub account first');
    const credentials = decryptIntegrationSecrets(row.encryptedSecrets);
    if (typeof credentials.accessToken !== 'string') throw new Error('Reconnect your GitHub account');
    if (typeof credentials.expiresAt !== 'number' || credentials.expiresAt > Date.now() + 60000) return credentials.accessToken;
    if (typeof credentials.refreshToken !== 'string'
      || (typeof credentials.refreshExpiresAt === 'number' && credentials.refreshExpiresAt <= Date.now())) {
      throw new Error('Your GitHub authorization expired. Please reconnect.');
    }
    const response = await axios.post('https://github.com/login/oauth/access_token', new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!, client_secret: process.env.GITHUB_CLIENT_SECRET!,
      grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
    }), { headers: { Accept: 'application/json' }, timeout: 15000 });
    const fresh = tokenSecrets(response.data);
    await tx.integration.update({ where: { id: row.id }, data: { encryptedSecrets: encryptIntegrationSecrets(fresh) } });
    return fresh.accessToken;
  }, { timeout: 25000 });
}

export async function githubGet<T = any>(path: string, token: string): Promise<T> {
  const response = await axios.get<T>(`https://api.github.com${path}`, { headers: githubHeaders(token), timeout: 15000 });
  return response.data;
}

export async function githubInstallations(token: string) {
  const installations: Array<{ id: number; account: { login: string }; suspended_at: string | null }> = [];
  for (let page = 1; page <= 10; page++) {
    const data = await githubGet(`/user/installations?per_page=100&page=${page}`, token);
    const batch = data.installations.filter((item: any) => String(item.app_id) === process.env.GITHUB_APP_ID && !item.suspended_at);
    installations.push(...batch);
    if (data.installations.length < 100) break;
  }
  return installations;
}

export function installationUrl(): string {
  return `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`;
}

export async function accessibleRepository(token: string, installationId: number, repositoryId: number) {
  const installations = await githubInstallations(token);
  if (!installations.some(item => item.id === installationId)) throw new Error('Repository access is unavailable');
  for (let page = 1; page <= 100; page++) {
    const data = await githubGet(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, token);
    const repo = data.repositories.find((item: any) => item.id === repositoryId);
    if (repo) return repo;
    if (data.repositories.length < 100) break;
  }
  throw new Error('Repository access is unavailable');
}
