import { createHash, randomBytes } from 'crypto';

/** Every key starts with this, which tells API keys apart from session JWTs ("eyJ..."). */
export const API_KEY_PREFIX = 'cmk_';
export const API_KEY_EXPIRY_DAYS = [30, 90, 180, 365];
export const DEFAULT_API_KEY_EXPIRY_DAYS = 90;
export const MAX_ACTIVE_API_KEYS = 10;

export type ApiKeyStatus = 'active' | 'expired' | 'revoked' | 'inactive';

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

// Keys carry 256 bits of randomness, so a plain SHA-256 digest cannot be
// reversed or guessed. A slow password hash would add nothing and would rule
// out the indexed lookup every request needs.
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 8), keyHash: hashApiKey(key) };
}

/**
 * A key acts as its owner, so it stops working when the owner is no longer an
 * admin, is disabled, or had their access changed (role, status, password or
 * revocation) after the key was created — the same rule session tokens follow.
 */
export function apiKeyStatus(
  key: { createdAt: Date; expiresAt: Date; revokedAt: Date | null },
  owner: { role: string; status: string; tokensValidAfter: Date | null },
  now = new Date()
): ApiKeyStatus {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt <= now) return 'expired';
  if (owner.role !== 'admin' || owner.status === 'disabled') return 'inactive';
  if (owner.tokensValidAfter && key.createdAt <= owner.tokensValidAfter) return 'inactive';
  return 'active';
}
