import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { PrismaClient, User } from '@prisma/client';
import * as jose from 'jose';
import { recordDeniedAudit as recordAudit } from '../services/audit.js';

export type Role = 'admin' | 'analyst' | 'auditor';

export interface AuthedRequest extends Request {
  user?: User;
}

const AUTH_MODE = (process.env.AUTH_MODE || 'local').toLowerCase(); // local | entra | oidc
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

// Fail fast: a missing/weak signing secret must never fall back to
// accepting-or-issuing tokens signed with an empty key.
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
}
if (AUTH_MODE === 'entra' && (!process.env.ENTRA_TENANT_ID || !process.env.ENTRA_AUDIENCE)) {
  throw new Error('AUTH_MODE=entra requires ENTRA_TENANT_ID');
}
// Fail closed on every var the mode depends on: a missing audience would
// otherwise accept tokens minted for any other client of the same issuer.
if (AUTH_MODE === 'oidc') {
  for (const key of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_CLIENT_ID', 'OIDC_HOSTED_UI'] as const) {
    if (!process.env[key]) throw new Error(`AUTH_MODE=oidc requires ${key}`);
  }
}

// Entra ID (config-gated; used when AUTH_MODE=entra)
const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID || '';
const ENTRA_AUDIENCE = process.env.ENTRA_AUDIENCE || '';
const entraJwks = ENTRA_TENANT_ID
  ? jose.createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/discovery/v2.0/keys`)
    )
  : null;

// Generic OIDC provider (config-gated; used when AUTH_MODE=oidc). Works with
// any spec-compliant issuer — Cognito, Keycloak, Auth0, ... The roles claim
// name is configurable because providers differ (Cognito: "cognito:groups",
// Keycloak: "roles" via a client mapper).
const OIDC_ISSUER = (process.env.OIDC_ISSUER || '').replace(/\/$/, '');
const OIDC_JWKS_URL =
  process.env.OIDC_JWKS_URL || (OIDC_ISSUER ? `${OIDC_ISSUER}/.well-known/jwks.json` : '');
const OIDC_AUDIENCE = process.env.OIDC_AUDIENCE || '';
const OIDC_ROLES_CLAIM = process.env.OIDC_ROLES_CLAIM || 'roles';
const oidcJwks = OIDC_JWKS_URL ? jose.createRemoteJWKSet(new URL(OIDC_JWKS_URL)) : null;

function entraGroupRoleMap(): Array<{ groupId: string; role: Role }> {
  const map: Array<{ groupId: string; role: Role }> = [];
  for (const [envKey, role] of [
    ['ENTRA_GROUP_ADMIN', 'admin'],
    ['ENTRA_GROUP_ANALYST', 'analyst'],
    ['ENTRA_GROUP_AUDITOR', 'auditor'],
  ] as const) {
    for (const groupId of (process.env[envKey] || '').split(',').map(s => s.trim()).filter(Boolean)) {
      map.push({ groupId, role });
    }
  }
  return map;
}

const secretKey = () => new TextEncoder().encode(JWT_SECRET);

export async function issueToken(user: User): Promise<string> {
  return await new jose.SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer('circini-backend')
    .setExpirationTime(JWT_EXPIRES_IN)
    .sign(secretKey());
}

async function verifyLocalToken(token: string): Promise<{ userId: string; issuedAt: number } | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secretKey(), { issuer: 'circini-backend', algorithms: ['HS256'] });
    return payload.sub && payload.iat ? { userId: payload.sub, issuedAt: payload.iat } : null;
  } catch {
    return null;
  }
}

/**
 * Entra mode: verify an Entra-issued access token against the tenant JWKS and
 * upsert a local User mirror (no password stored) — AD group / app-role claims
 * map to the application role.
 */
async function verifyEntraToken(prisma: PrismaClient, token: string): Promise<User | null> {
  if (!entraJwks) return null;
  try {
    const { payload } = await jose.jwtVerify(token, entraJwks, {
      issuer: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`,
      ...(ENTRA_AUDIENCE ? { audience: ENTRA_AUDIENCE } : {}),
    });

    const oid = (payload.oid as string) || payload.sub!;
    const email =
      (payload.preferred_username as string) || (payload.email as string) || `${oid}@entra.local`;
    const name = (payload.name as string) || null;

    // App roles claim takes precedence, then AD group mapping, else analyst
    let role: Role = 'analyst';
    const claimRoles = (payload.roles as string[] | undefined) || [];
    if (claimRoles.includes('admin')) role = 'admin';
    else if (claimRoles.includes('auditor')) role = 'auditor';
    else {
      const groups = (payload.groups as string[] | undefined) || [];
      for (const { groupId, role: mapped } of entraGroupRoleMap()) {
        if (groups.includes(groupId)) {
          role = mapped;
          if (mapped === 'admin') break;
        }
      }
    }

    const existing = await prisma.user.findUnique({ where: { entraOid: oid } });
    if (existing) {
      if (!tokenIsCurrent(existing, payload.iat)) return null;
      return await prisma.user.update({ where: { id: existing.id }, data: {
        email, name, ...(!existing.roleManagedLocally ? { role } : {}), lastLoginAt: new Date(),
      } });
    }
    return await prisma.user.create({ data: { entraOid: oid, email, name, role } });
  } catch {
    return null;
  }
}

/**
 * OIDC mode: verify a token from the configured issuer against its JWKS and
 * upsert a local User mirror, exactly like Entra mode. The subject claim is
 * stored in the same external-identity column (entraOid) to avoid a schema
 * change; role comes from the configured roles claim, defaulting to analyst.
 */
async function verifyOidcToken(prisma: PrismaClient, token: string): Promise<User | null> {
  if (!oidcJwks) return null;
  try {
    const { payload } = await jose.jwtVerify(token, oidcJwks, {
      issuer: OIDC_ISSUER,
      ...(OIDC_AUDIENCE ? { audience: OIDC_AUDIENCE } : {}),
    });

    // Cognito stamps token_use on both token types; only the ID token carries
    // the audience and identity claims we authorize on. Reject access tokens
    // rather than relying on the aud check alone to exclude them.
    if (payload.token_use !== undefined && payload.token_use !== 'id') return null;

    const sub = payload.sub!;
    const email =
      (payload.email as string) ||
      (payload.preferred_username as string) ||
      (payload['cognito:username'] as string) ||
      `${sub}@oidc.local`;
    const name = (payload.name as string) || null;

    let role: Role = 'analyst';
    // Array check matters: a string-valued claim would turn .includes() into a
    // substring test ("aws.cognito.signin.user.admin" would grant admin).
    const rawRoles = payload[OIDC_ROLES_CLAIM];
    const claimRoles = Array.isArray(rawRoles) ? (rawRoles as string[]) : [];
    if (claimRoles.includes('admin')) role = 'admin';
    else if (claimRoles.includes('auditor')) role = 'auditor';

    // Resolve the local mirror. Prefer the stable IdP subject; fall back to
    // email ONLY to link a pre-provisioned local account (admin portal, seed)
    // on its first SSO login. Guardrails against an email-claim takeover:
    //   - the token must assert email_verified (Cognito sets this true for
    //     admin-created users; a forged/unverified email cannot link)
    //   - link by email only when that account is not already bound to an IdP
    //     identity, so an existing SSO account can never be rebound
    // Role still derives from the admin-controlled cognito:groups claim (users
    // cannot self-join groups and self-signup is disabled), so it is not a
    // user-settable elevation vector.
    let existing = await prisma.user.findUnique({ where: { entraOid: sub } });
    if (!existing && payload.email_verified === true) {
      const byEmail = await prisma.user.findUnique({ where: { email } });
      if (byEmail && byEmail.entraOid == null) existing = byEmail;
    }
    if (existing) {
      if (!tokenIsCurrent(existing, payload.iat)) return null;
      return await prisma.user.update({
        where: { id: existing.id },
        data: { entraOid: sub, email, name, ...(!existing.roleManagedLocally ? { role } : {}), lastLoginAt: new Date() },
      });
    }
    return await prisma.user.create({ data: { entraOid: sub, email, name, role } });
  } catch {
    return null;
  }
}

/** Paths that skip user authentication entirely. */
const PUBLIC_PATHS = ['/api/health', '/api/auth/login', '/api/auth/config'];

/** Guard for service-to-service endpoints (AI service -> backend). Fail-closed:
 * an unconfigured key refuses the request rather than skipping auth. */
export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.INTERNAL_API_KEY;
  if (!configured) {
    return res.status(503).json({ error: 'Internal service auth is not configured' });
  }
  const supplied = typeof req.headers['x-internal-key'] === 'string' ? req.headers['x-internal-key'] : '';
  if (Buffer.byteLength(supplied) !== Buffer.byteLength(configured) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(configured))) {
    return res.status(401).json({ error: 'Invalid internal key' });
  }
  next();
}

/**
 * Resolve a bearer token to a User according to the configured auth mode.
 * Shared by the HTTP middleware and the Socket.IO handshake — the socket
 * path previously verified only local JWTs, which rejected every OIDC token.
 */
export async function resolveUserFromToken(
  prisma: PrismaClient,
  token: string
): Promise<User | null> {
  if (AUTH_MODE === 'entra') return await verifyEntraToken(prisma, token);
  if (AUTH_MODE === 'oidc') return await verifyOidcToken(prisma, token);
  const decoded = await verifyLocalToken(token);
  if (!decoded) return null;
  const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
  return user && tokenIsCurrent(user, decoded.issuedAt) ? user : null;
}

export function authenticate(prisma: PrismaClient) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    // Only an exact-match allowlist is exempt. Service-to-service routes are
    // NOT exempted by prefix here — they are registered ahead of this
    // middleware in index.ts with their own fail-closed requireInternalKey
    // guard, so a newly added route can never silently inherit an exemption.
    if (PUBLIC_PATHS.includes(req.path)) return next();

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = await resolveUserFromToken(prisma, token).catch(() => null);

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (user.status === 'disabled') {
      await recordAudit(prisma, {
        userId: user.id,
        action: 'auth.denied',
        decision: 'deny',
        severity: 'warning',
        detail: JSON.stringify({ reason: 'account disabled' }),
        ip: req.ip,
      });
      return res.status(403).json({ error: 'Account is disabled' });
    }

    req.user = user;
    next();
  };
}

/** Role gate. Usage: router.get('/x', requireRole('admin', 'auditor'), handler) */
export function requireRole(...roles: Role[]) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user || !roles.includes(user.role as Role)) {
      const prisma: PrismaClient = req.app.locals.prisma;
      await recordAudit(prisma, {
        userId: user?.id,
        action: 'authz.denied',
        resource: req.path,
        decision: 'deny',
        severity: 'warning',
        detail: JSON.stringify({ required: roles, actual: user?.role }),
        ip: req.ip,
      });
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Writes (chat, uploads, session mutation) are denied for restricted accounts
 * and for auditors (read-only role).
 */
export async function requireWriteAccess(req: AuthedRequest, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.role === 'auditor' || user.status === 'restricted') {
    const prisma: PrismaClient = req.app.locals.prisma;
    await recordAudit(prisma, {
      userId: user.id,
      action: 'authz.denied',
      resource: req.path,
      decision: 'deny',
      severity: 'warning',
      detail: JSON.stringify({
        reason: user.role === 'auditor' ? 'auditor is read-only' : 'account restricted',
      }),
      ip: req.ip,
    });
    return res.status(403).json({
      error:
        user.role === 'auditor'
          ? 'Auditor role is read-only'
          : 'Account is restricted — contact an administrator',
    });
  }
  next();
}

/** Row-level scoping: admins see everything; analysts only their own sessions. */
export function canAccessSession(
  user: User,
  session: { ownerUserId: string | null }
): boolean {
  if (user.role === 'admin') return true;
  if (user.role === 'auditor') return false;
  // Legacy sessions (created before auth existed) have no owner — admin-only.
  return session.ownerUserId === user.id;
}

/** Seed the initial admin account in local mode so the portal is reachable. */
export async function seedAdminUser(prisma: PrismaClient) {
  if (AUTH_MODE !== 'local') return;
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@callsphere.tech';
  const existing = await prisma.user.count({ where: { role: 'admin' } });
  if (existing > 0) return;
  // Never fall back to a hardcoded password: that would silently create a
  // known-credential admin on any deploy where the env var was forgotten.
  // Skipping (rather than throwing) keeps a running service up; the operator
  // sets the var and restarts to get their admin account.
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    console.error(
      '[AUTH] No admin account exists and SEED_ADMIN_PASSWORD is unset or shorter ' +
        'than 12 characters — skipping admin seed. Set SEED_ADMIN_PASSWORD to a ' +
        'strong value and restart to create the initial admin.'
    );
    return;
  }
  const bcrypt = await import('bcryptjs');
  await prisma.user.create({
    data: {
      email,
      name: 'Administrator',
      role: 'admin',
      passwordHash: await bcrypt.default.hash(password, 12),
    },
  });
  console.log(`[AUTH] Seeded initial admin user: ${email} (change the password immediately)`);
}


export function tokenIsCurrent(user: { tokensValidAfter: Date | null }, issuedAt?: number): boolean {
  return typeof issuedAt === 'number' && Number.isFinite(issuedAt)
    && (!user.tokensValidAfter || issuedAt * 1000 > user.tokensValidAfter.getTime());
}
