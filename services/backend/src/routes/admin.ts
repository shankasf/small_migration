import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuthedRequest, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

const VALID_ROLES = ['admin', 'analyst', 'auditor'];
const VALID_STATUSES = ['active', 'restricted', 'disabled'];

function publicUser(user: any) {
  const { passwordHash, ...rest } = user;
  return rest;
}

// ---------- User management (admin only) ----------

// List users with usage aggregates
router.get('/users', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [users, totals, monthTotals, sessionCounts] = await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.usageRecord.groupBy({
        by: ['userId'],
        _sum: { totalTokens: true, costUsd: true },
        _count: { _all: true },
      }),
      prisma.usageRecord.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: startOfMonth } },
        _sum: { totalTokens: true, costUsd: true },
      }),
      prisma.session.groupBy({ by: ['ownerUserId'], _count: { _all: true } }),
    ]);

    const totalByUser = new Map(totals.map(t => [t.userId, t]));
    const monthByUser = new Map(monthTotals.map(t => [t.userId, t]));
    const sessionsByUser = new Map(sessionCounts.map(s => [s.ownerUserId, s._count._all]));

    res.json(
      users.map(u => ({
        ...publicUser(u),
        usage: {
          totalTokens: totalByUser.get(u.id)?._sum.totalTokens || 0,
          totalCostUsd: totalByUser.get(u.id)?._sum.costUsd || 0,
          requests: totalByUser.get(u.id)?._count._all || 0,
          monthTokens: monthByUser.get(u.id)?._sum.totalTokens || 0,
          monthCostUsd: monthByUser.get(u.id)?._sum.costUsd || 0,
          sessions: sessionsByUser.get(u.id) || 0,
        },
      }))
    );
  } catch (error) {
    console.error('Error listing users:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Create user
router.post('/users', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { email, name, role, password, dailyTokenLimit, monthlyTokenLimit } = req.body || {};

    if (!email || !password || String(password).length < 10) {
      return res.status(400).json({ error: 'Email and a password of at least 10 characters are required' });
    }
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const user = await prisma.user.create({
      data: {
        email: String(email).toLowerCase(),
        name: name || null,
        role: role || 'analyst',
        passwordHash: await bcrypt.hash(String(password), 12),
        dailyTokenLimit: dailyTokenLimit ?? null,
        monthlyTokenLimit: monthlyTokenLimit ?? null,
      },
    });

    recordAudit(prisma, {
      userId: req.user!.id,
      action: 'admin.user_create',
      resource: user.id,
      detail: JSON.stringify({ email: user.email, role: user.role }),
      ip: req.ip,
    });
    res.status(201).json(publicUser(user));
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user: role, status (disable/restrict), token caps, password reset
router.patch('/users/:id', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { id } = req.params;
    const { role, status, dailyTokenLimit, monthlyTokenLimit, name, password } = req.body || {};

    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    // An admin cannot disable or demote themselves (prevents lockout)
    if (id === req.user!.id && (status === 'disabled' || (role && role !== 'admin'))) {
      return res.status(400).json({ error: 'You cannot disable or demote your own account' });
    }
    if (password && String(password).length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters' });
    }

    const data: any = {};
    if (role !== undefined) data.role = role;
    if (status !== undefined) data.status = status;
    if (name !== undefined) data.name = name;
    if (dailyTokenLimit !== undefined) data.dailyTokenLimit = dailyTokenLimit;
    if (monthlyTokenLimit !== undefined) data.monthlyTokenLimit = monthlyTokenLimit;
    if (password) data.passwordHash = await bcrypt.hash(String(password), 12);

    const user = await prisma.user.update({ where: { id }, data });

    recordAudit(prisma, {
      userId: req.user!.id,
      action: 'admin.user_update',
      resource: id,
      severity: status === 'disabled' || status === 'restricted' ? 'warning' : 'info',
      detail: JSON.stringify({
        changed: Object.keys(data).filter(k => k !== 'passwordHash'),
        ...(password ? { passwordReset: true } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(status !== undefined ? { status } : {}),
      }),
      ip: req.ip,
    });
    res.json(publicUser(user));
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ---------- Usage analytics (admin only) ----------

router.get('/usage/summary', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totals, byModel, records] = await Promise.all([
      prisma.usageRecord.aggregate({
        where: { createdAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true, totalTokens: true, costUsd: true },
        _count: { _all: true },
      }),
      prisma.usageRecord.groupBy({
        by: ['model', 'provider'],
        where: { createdAt: { gte: since } },
        _sum: { totalTokens: true, costUsd: true },
        _count: { _all: true },
      }),
      prisma.usageRecord.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true, totalTokens: true, costUsd: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Daily series (UTC buckets)
    const daily = new Map<string, { tokens: number; costUsd: number; requests: number }>();
    for (const r of records) {
      const day = r.createdAt.toISOString().slice(0, 10);
      const bucket = daily.get(day) || { tokens: 0, costUsd: 0, requests: 0 };
      bucket.tokens += r.totalTokens;
      bucket.costUsd += r.costUsd;
      bucket.requests += 1;
      daily.set(day, bucket);
    }

    res.json({
      windowDays: days,
      totals: {
        inputTokens: totals._sum.inputTokens || 0,
        outputTokens: totals._sum.outputTokens || 0,
        totalTokens: totals._sum.totalTokens || 0,
        costUsd: totals._sum.costUsd || 0,
        requests: totals._count._all,
      },
      byModel: byModel.map(m => ({
        model: m.model,
        provider: m.provider,
        totalTokens: m._sum.totalTokens || 0,
        costUsd: m._sum.costUsd || 0,
        requests: m._count._all,
      })),
      daily: Array.from(daily.entries()).map(([date, v]) => ({ date, ...v })),
    });
  } catch (error) {
    console.error('Error building usage summary:', error);
    res.status(500).json({ error: 'Failed to build usage summary' });
  }
});

// ---------- AI service activity (admin + auditor) ----------

// Backfill for the live log view: everything emitted since the backend
// process started, i.e. since the last deployment (in-memory ring buffer).
router.get('/ailogs', requireRole('admin', 'auditor'), (req: AuthedRequest, res: Response) => {
  res.json(req.app.locals.adminLogBuffer ?? []);
});

// ---------- Audit / security events (admin + auditor) ----------

router.get('/audit', requireRole('admin', 'auditor'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const { userId, action, decision, severity } = req.query as Record<string, string>;

    const events = await prisma.auditEvent.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(action ? { action: { startsWith: action } } : {}),
        ...(decision ? { decision } : {}),
        ...(severity ? { severity } : {}),
      },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    recordAudit(prisma, {
      userId: req.user!.id,
      action: 'audit.view',
      detail: JSON.stringify({ filters: { userId, action, decision, severity }, limit }),
      ip: req.ip,
    });
    res.json(events);
  } catch (error) {
    console.error('Error listing audit events:', error);
    res.status(500).json({ error: 'Failed to list audit events' });
  }
});

// Security overview: denials, guardrail blocks, disabled accounts
router.get('/security/summary', requireRole('admin', 'auditor'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [byActionRaw, recent] = await Promise.all([
      prisma.auditEvent.groupBy({
        by: ['action', 'decision'],
        where: { createdAt: { gte: since }, decision: { not: 'allow' } },
        _count: { _all: true },
      }),
      prisma.auditEvent.findMany({
        where: { createdAt: { gte: since }, OR: [{ decision: { not: 'allow' } }, { severity: { not: 'info' } }] },
        include: { user: { select: { email: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    res.json({
      windowDays: days,
      counts: byActionRaw.map(a => ({ action: a.action, decision: a.decision, count: a._count._all })),
      recent,
    });
  } catch (error) {
    console.error('Error building security summary:', error);
    res.status(500).json({ error: 'Failed to build security summary' });
  }
});

export default router;
