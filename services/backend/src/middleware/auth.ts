import { Request, Response, NextFunction } from 'express';
import { PrismaClient, User } from '@prisma/client';
import * as jose from 'jose';
import { recordAudit } from '../services/audit.js';

export type Role = 'admin' | 'analyst' | 'auditor';

export interface AuthedRequest extends Request {
  user?: User;
}

const AUTH_MODE = (process.env.AUTH_MODE || 'local').toLowerCase(); // local | entra
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

// Fail fast: a missing/weak signing secret must never fall back to
// accepting-or-issuing tokens signed with an empty key.
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
}
if (AUTH_MODE === 'entra' && !process.env.ENTRA_TENANT_ID) {
  throw new Error('AUTH_MODE=entra requires ENTRA_TENANT_ID');
}

// Entra ID (config-gated; used when AUTH_MODE=entra)
const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID || '';
const ENTRA_AUDIENCE = process.env.ENTRA_AUDIENCE || '';
const entraJwks = ENTRA_TENANT_ID
  ? jose.createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/discovery/v2.0/keys`)
    )
  : null;

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

async function verifyLocalToken(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secretKey(), { issuer: 'circini-backend' });
    return payload.sub ? { userId: payload.sub } : null;
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

    return await prisma.user.upsert({
      where: { entraOid: oid },
      update: { email, name, role, lastLoginAt: new Date() },
      create: { entraOid: oid, email, name, role },
    });
  } catch {
    return null;
  }
}

/** Paths that skip user authentication entirely. */
const PUBLIC_PATHS = ['/api/health', '/api/auth/login'];

/** Guard for service-to-service endpoints (AI service -> backend). Fail-closed:
 * an unconfigured key refuses the request rather than skipping auth. */
export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.INTERNAL_API_KEY;
  if (!configured) {
    return res.status(503).json({ error: 'Internal service auth is not configured' });
  }
  if (req.headers['x-internal-key'] !== configured) {
    return res.status(401).json({ error: 'Invalid internal key' });
  }
  next();
}

export function authenticate(prisma: PrismaClient) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (PUBLIC_PATHS.includes(req.path)) return next();
    // Internal endpoints authenticate with x-internal-key, not user JWTs
    if (req.path.startsWith('/api/logs/') || req.path.startsWith('/api/internal/')) return next();

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let user: User | null = null;
    if (AUTH_MODE === 'entra') {
      user = await verifyEntraToken(prisma, token);
    } else {
      const decoded = await verifyLocalToken(token);
      if (decoded) {
        user = await prisma.user.findUnique({ where: { id: decoded.userId } });
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (user.status === 'disabled') {
      recordAudit(prisma, {
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
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user || !roles.includes(user.role as Role)) {
      const prisma: PrismaClient = req.app.locals.prisma;
      recordAudit(prisma, {
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
export function requireWriteAccess(req: AuthedRequest, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.role === 'auditor' || user.status === 'restricted') {
    const prisma: PrismaClient = req.app.locals.prisma;
    recordAudit(prisma, {
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
  const bcrypt = await import('bcryptjs');
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
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
