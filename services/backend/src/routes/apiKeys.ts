import { Router, Request, Response } from 'express';
import { ApiKey, PrismaClient, User } from '@prisma/client';
import { AuthedRequest, requireRole, requireSessionToken } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import {
  API_KEY_EXPIRY_DAYS,
  DEFAULT_API_KEY_EXPIRY_DAYS,
  MAX_ACTIVE_API_KEYS,
  apiKeyStatus,
  generateApiKey,
} from '../services/apiKeys.js';

const router = Router();
const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

const OWNER_FIELDS = { id: true, email: true, name: true, role: true, status: true, tokensValidAfter: true } as const;
type KeyWithOwner = ApiKey & { user: Pick<User, keyof typeof OWNER_FIELDS> };

// Only admins manage keys, and only from a signed-in session. Admins see every
// key, so any admin can revoke a key another admin left behind.
router.use(requireRole('admin'), requireSessionToken);

function keyView(key: KeyWithOwner, now = new Date()) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    status: apiKeyStatus(key, key.user, now),
    owner: { id: key.user.id, email: key.user.email, name: key.user.name },
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const keys = await getPrisma(req).apiKey.findMany({
      include: { user: { select: OWNER_FIELDS } },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    res.json({ keys: keys.map(key => keyView(key, now)), expiryDays: API_KEY_EXPIRY_DAYS });
  } catch (error) {
    console.error('Failed to list API keys:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to load API keys' });
  }
});

router.post('/', async (req: AuthedRequest, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const expiresInDays = Number(req.body?.expiresInDays ?? DEFAULT_API_KEY_EXPIRY_DAYS);
  if (!name || name.length > 80) {
    return res.status(400).json({ error: 'A name of up to 80 characters is required' });
  }
  if (!API_KEY_EXPIRY_DAYS.includes(expiresInDays)) {
    return res.status(400).json({ error: `Expiry must be one of: ${API_KEY_EXPIRY_DAYS.join(', ')} days` });
  }
  try {
    const prisma = getPrisma(req);
    const userId = req.user!.id;
    const active = await prisma.apiKey.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } });
    if (active >= MAX_ACTIVE_API_KEYS) {
      return res.status(409).json({ error: `You already have ${MAX_ACTIVE_API_KEYS} active API keys — revoke one first` });
    }
    const { key, prefix, keyHash } = generateApiKey();
    const created = await prisma.apiKey.create({
      data: { userId, name, prefix, keyHash, expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) },
      include: { user: { select: OWNER_FIELDS } },
    });
    await recordAudit(prisma, {
      userId,
      action: 'api_key.create',
      resource: created.id,
      detail: JSON.stringify({ type: 'api_key' }),
      ip: req.ip,
    });
    // The only response that carries the key itself; it is never stored or shown again.
    res.status(201).json({ key: keyView(created), secret: key });
  } catch (error) {
    console.error('Failed to create API key:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.delete('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
    if (!key) return res.status(404).json({ error: 'API key not found' });
    if (!key.revokedAt) {
      await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
      await recordAudit(prisma, { userId: req.user!.id, action: 'api_key.revoke', resource: key.id, ip: req.ip });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Failed to revoke API key:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

export default router;
