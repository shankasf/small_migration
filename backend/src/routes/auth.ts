import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuthedRequest, issueToken } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

function publicUser(user: any) {
  const { passwordHash, ...rest } = user;
  return rest;
}

// Login (local mode). In entra mode the SPA acquires tokens from Entra ID
// directly (MSAL) and this endpoint is not used.
router.post('/login', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    const passwordOk = user?.passwordHash
      ? await bcrypt.compare(String(password), user.passwordHash)
      : false;

    if (!user || !passwordOk) {
      recordAudit(prisma, {
        userId: user?.id,
        action: 'auth.login',
        decision: 'deny',
        severity: 'warning',
        detail: JSON.stringify({ email: String(email).toLowerCase(), reason: 'bad credentials' }),
        ip: req.ip,
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.status === 'disabled') {
      recordAudit(prisma, {
        userId: user.id,
        action: 'auth.login',
        decision: 'deny',
        severity: 'warning',
        detail: JSON.stringify({ reason: 'account disabled' }),
        ip: req.ip,
      });
      return res.status(403).json({ error: 'Account is disabled' });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    recordAudit(prisma, { userId: user.id, action: 'auth.login', ip: req.ip });

    const token = await issueToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Current user
router.get('/me', (req: AuthedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  res.json(publicUser(req.user));
});

// Change own password (local mode)
router.post('/change-password', async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || String(newPassword).length < 10) {
      return res
        .status(400)
        .json({ error: 'Current password and a new password (min 10 chars) are required' });
    }
    const ok = user.passwordHash
      ? await bcrypt.compare(String(currentPassword), user.passwordHash)
      : false;
    if (!ok) {
      recordAudit(prisma, {
        userId: user.id,
        action: 'auth.change_password',
        decision: 'deny',
        severity: 'warning',
        ip: req.ip,
      });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(String(newPassword), 12) },
    });
    recordAudit(prisma, { userId: user.id, action: 'auth.change_password', ip: req.ip });
    res.json({ ok: true });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export default router;
