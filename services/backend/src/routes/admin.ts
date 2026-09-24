import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuthedRequest, requireRole } from '../middleware/auth.js';
import { retentionPolicy } from '../services/retention.js';
import { securityStatus, cancelUserRuns, userMemory, forgetUserMemory } from '../services/aiService.js';
import { recordAudit } from '../services/audit.js';
import { FEEDBACK_RATINGS } from '../services/feedback.js';

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
    console.error('Error listing users:', error instanceof Error ? error.name : 'unknown');
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

    await recordAudit(prisma, {
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
    console.error('Error creating user:', error instanceof Error ? error.name : 'unknown');
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

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const data: any = {};
    if (role !== undefined) { data.role = role; data.roleManagedLocally = true; }
    // Only a real access change cuts off sessions and API keys. The edit dialog
    // always resends role and status, so saving it to change a token limit must
    // not sign the user out or disable their keys.
    const accessChanged = (role !== undefined && role !== existing.role)
      || (status !== undefined && status !== existing.status)
      || Boolean(password);
    if (accessChanged) data.tokensValidAfter = new Date();
    if (status !== undefined) data.status = status;
    if (name !== undefined) data.name = name;
    if (dailyTokenLimit !== undefined) data.dailyTokenLimit = dailyTokenLimit;
    if (monthlyTokenLimit !== undefined) data.monthlyTokenLimit = monthlyTokenLimit;
    if (password) data.passwordHash = await bcrypt.hash(String(password), 12);

    const user = await prisma.user.update({ where: { id }, data });
    req.app.locals.io?.in(`user:${id}`).disconnectSockets(true);
    if (data.tokensValidAfter) await cancelUserRuns(id);

    await recordAudit(prisma, {
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
    console.error('Error updating user:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.post('/users/:id/revoke', requireRole('admin'), async (req: AuthedRequest, res: Response, next) => {
  try {
    if (req.params.id === req.user!.id) return res.status(400).json({error: 'Use sign out for your own session'});
    const prisma = getPrisma(req);
    await prisma.user.update({ where: { id: req.params.id }, data: { tokensValidAfter: new Date(), status: 'disabled' } });
    req.app.locals.io?.in(`user:${req.params.id}`).disconnectSockets(true);
    await cancelUserRuns(req.params.id);
    await recordAudit(prisma, { userId: req.user!.id, action: 'admin.access_revoked', resource: req.params.id, severity: 'critical' });
    res.json({ok: true});
  } catch (error) { next(error); }
});

// Long-term memory is the user's own standing instructions, kept without
// expiry, so it has to be inspectable and erasable on request.
router.get('/users/:id/memory', requireRole('admin'), async (req: AuthedRequest, res: Response, next) => {
  try {
    res.json({ memories: await userMemory(req.params.id) });
  } catch (error) { next(error); }
});

router.delete('/users/:id/memory', requireRole('admin'), async (req: AuthedRequest, res: Response, next) => {
  try {
    const forgotten = await forgetUserMemory(req.params.id);
    await recordAudit(getPrisma(req), { userId: req.user!.id, action: 'admin.memory_erased',
      resource: req.params.id, detail: JSON.stringify({ forgotten }) });
    res.json({ forgotten });
  } catch (error) { next(error); }
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
    console.error('Error building usage summary:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to build usage summary' });
  }
});

// ---------- AI service activity (admin + auditor) ----------

// Durable AI activity history: one row per guardrail decision, model call,
// tool call/result, final output and turn summary — each attributed to the
// user whose turn produced it. Filterable by user id so admins can read one
// user's agent trail rather than the whole firehose.
router.get('/ailogs', requireRole('admin', 'auditor'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 1000);
    const { userId, sessionId, turnId, step, type, tool, q } = req.query as Record<string, string>;
    const days = Math.min(parseInt(req.query.days as string) || 7, 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const where = {
      createdAt: { gte: since },
      ...(userId ? { userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(step ? { step } : {}),
      ...(type ? { type } : {}),
      ...(tool ? { tool } : {}),
      ...(q
        ? {
            OR: [
              { message: { contains: q, mode: 'insensitive' as const } },
              { detail: { contains: q, mode: 'insensitive' as const } },
              { sessionId: { contains: q, mode: 'insensitive' as const } },
              { turnId: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    // Per-model-call rows and the per-turn rollup carry the same tokens, so
    // summing both would double-count. With no step filter the rollup is the
    // one that counts; when the caller has asked for a single step there is
    // nothing to double-count and the filtered set is summed as-is.
    const totalsWhere = step ? where : { ...where, step: { not: 'llm.call' } };

    const [rows, totals] = await Promise.all([
      prisma.aiActivityLog.findMany({
        where,
        include: { user: { select: { email: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.aiActivityLog.aggregate({
        where: totalsWhere,
        _sum: { inputTokens: true, outputTokens: true, totalTokens: true, costUsd: true },
        _count: { _all: true },
      }),
    ]);

    res.json({
      windowDays: days,
      totals: {
        events: totals._count._all,
        inputTokens: totals._sum.inputTokens || 0,
        outputTokens: totals._sum.outputTokens || 0,
        totalTokens: totals._sum.totalTokens || 0,
        costUsd: totals._sum.costUsd || 0,
      },
      // Oldest-first so the live view can simply append new events.
      entries: rows.reverse().map(r => ({
        id: r.id,
        sessionId: r.sessionId,
        turnId: r.turnId,
        userId: r.userId,
        userEmail: r.user?.email ?? null,
        timestamp: r.createdAt.toISOString(),
        step: r.step,
        type: r.type,
        message: r.message,
        tool: r.tool,
        provider: r.provider,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.totalTokens,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        detail: r.detail,
      })),
    });
  } catch (error) {
    console.error('Error listing AI activity:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to list AI activity' });
  }
});

// Filter facets for the AI log view: who has activity in the window, with
// their per-user totals, plus the tools and event types actually seen.
router.get('/ailogs/facets', requireRole('admin', 'auditor'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const days = Math.min(parseInt(req.query.days as string) || 7, 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [byUser, byTool, bySteps] = await Promise.all([
      // Per-user tokens/cost come from turn rollups only — see the note on
      // totalsWhere above; the event count still covers every row.
      prisma.aiActivityLog.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: since }, step: { not: 'llm.call' } },
        _sum: { totalTokens: true, costUsd: true },
        _count: { _all: true },
      }),
      prisma.aiActivityLog.groupBy({
        by: ['tool'],
        where: { createdAt: { gte: since }, tool: { not: null } },
        _count: { _all: true },
      }),
      prisma.aiActivityLog.groupBy({
        by: ['step'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    const userIds = byUser.map(u => u.userId).filter((id): id is string => !!id);
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true },
        })
      : [];
    const emailById = new Map(users.map(u => [u.id, u]));

    res.json({
      windowDays: days,
      users: byUser
        .map(u => ({
          userId: u.userId,
          email: u.userId ? emailById.get(u.userId)?.email ?? '(deleted user)' : '(unattributed)',
          name: u.userId ? emailById.get(u.userId)?.name ?? null : null,
          events: u._count._all,
          totalTokens: u._sum.totalTokens || 0,
          costUsd: u._sum.costUsd || 0,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens || b.events - a.events),
      tools: byTool.map(t => ({ tool: t.tool as string, calls: t._count._all }))
        .sort((a, b) => b.calls - a.calls),
      steps: bySteps.map(t => ({ step: t.step, events: t._count._all }))
        .sort((a, b) => b.events - a.events),
    });
  } catch (error) {
    console.error('Error building AI log facets:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to build AI log facets' });
  }
});

// ---------- Response feedback (admin only) ----------

// Every thumb left on an assistant response, across all users. The thumb is
// the signal; the note, when a user chose to leave one, is their own words.
// Rows carry the rated response and the prompt that produced it, so a thumbs
// down can be read in context without opening the thread.
/** Single-line preview of stored content for a table cell. */
function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}\u2026` : flat;
}

router.get('/feedback', requireRole('admin'), async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const { rating, userId, q } = req.query as Record<string, string>;
    const withNote = req.query.withNote === 'true';

    // The rating filter is deliberately left out of `scope`: the up/down split
    // has to stay comparable while the operator is reading one side of it.
    const scope = {
      createdAt: { gte: since },
      ...(userId ? { userId } : {}),
      ...(withNote ? { note: { not: null } } : {}),
      ...(q
        ? {
            OR: [
              { note: { contains: q, mode: 'insensitive' as const } },
              { message: { content: { contains: q, mode: 'insensitive' as const } } },
              { sessionId: { contains: q, mode: 'insensitive' as const } },
              { messageId: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const where = { ...scope, ...(FEEDBACK_RATINGS.includes(rating) ? { rating } : {}) };

    const [rows, splits, notes, byUser] = await Promise.all([
      prisma.messageFeedback.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, name: true } },
          message: {
            select: { id: true, content: true, createdAt: true, sessionId: true, session: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.messageFeedback.groupBy({ by: ['rating'], where: scope, _count: { _all: true } }),
      prisma.messageFeedback.count({ where: { ...scope, note: { not: null } } }),
      prisma.messageFeedback.groupBy({
        by: ['userId', 'rating'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    // The prompt behind each rated response, in two bounded queries rather than
    // one per row: walk the involved threads by timestamp alone (no content),
    // then fetch only the prompts that are actually shown.
    const sessionIds = Array.from(new Set(rows.map(r => r.message.sessionId)));
    const timeline = sessionIds.length
      ? await prisma.message.findMany({
          where: { sessionId: { in: sessionIds } },
          select: { id: true, sessionId: true, role: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const promptIdByMessage = new Map<string, string>();
    for (const row of rows) {
      const rated = row.message;
      const prompt = timeline
        .filter(m => m.sessionId === rated.sessionId && m.role === 'user'
          && m.id !== rated.id && m.createdAt <= rated.createdAt)
        .pop();
      if (prompt) promptIdByMessage.set(rated.id, prompt.id);
    }
    const promptIds = Array.from(new Set(promptIdByMessage.values()));
    const prompts = promptIds.length
      ? await prisma.message.findMany({ where: { id: { in: promptIds } }, select: { id: true, content: true } })
      : [];
    const promptById = new Map(prompts.map(p => [p.id, p.content]));

    const userIds = Array.from(new Set(byUser.map(u => u.userId).filter((id): id is string => !!id)));
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } })
      : [];
    const userById = new Map(users.map(u => [u.id, u]));

    const up = splits.find(s => s.rating === 'up')?._count._all || 0;
    const down = splits.find(s => s.rating === 'down')?._count._all || 0;
    const perUser = new Map<string, { userId: string | null; email: string; name: string | null; up: number; down: number }>();
    for (const entry of byUser) {
      const key = entry.userId || '';
      const seat = perUser.get(key) || {
        userId: entry.userId,
        email: entry.userId ? userById.get(entry.userId)?.email ?? '(deleted user)' : '(unattributed)',
        name: entry.userId ? userById.get(entry.userId)?.name ?? null : null,
        up: 0,
        down: 0,
      };
      if (entry.rating === 'up') seat.up += entry._count._all;
      if (entry.rating === 'down') seat.down += entry._count._all;
      perUser.set(key, seat);
    }

    await recordAudit(prisma, {
      userId: req.user!.id,
      action: 'admin.feedback_view',
      detail: JSON.stringify({ filters: { rating, userId, q: q ? 'set' : undefined }, limit }),
      ip: req.ip,
    });

    res.json({
      windowDays: days,
      summary: {
        total: up + down,
        up,
        down,
        withNotes: notes,
        // Share of rated responses marked useful; null until anything is rated.
        satisfaction: up + down > 0 ? up / (up + down) : null,
      },
      users: Array.from(perUser.values())
        .map(u => ({ ...u, total: u.up + u.down }))
        .sort((a, b) => b.total - a.total),
      entries: rows.map(r => ({
        id: r.id,
        rating: r.rating,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        userId: r.userId,
        userEmail: r.user?.email ?? '(deleted user)',
        userName: r.user?.name ?? null,
        messageId: r.message.id,
        sessionId: r.message.sessionId,
        sessionName: r.message.session?.name ?? null,
        response: excerpt(r.message.content, 600),
        prompt: (() => {
          const id = promptIdByMessage.get(r.message.id);
          return id ? excerpt(promptById.get(id) || '', 300) : null;
        })(),
      })),
    });
  } catch (error) {
    console.error('Error listing feedback:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to list feedback' });
  }
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

    await recordAudit(prisma, {
      userId: req.user!.id,
      action: 'audit.view',
      detail: JSON.stringify({ filters: { userId, action, decision, severity }, limit }),
      ip: req.ip,
    });
    res.json(events);
  } catch (error) {
    console.error('Error listing audit events:', error instanceof Error ? error.name : 'unknown');
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
    console.error('Error building security summary:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to build security summary' });
  }
});

router.get('/security/configuration', requireRole('admin', 'auditor'), async (_req, res, next) => {
  try { res.json({ ...await securityStatus(),
    retention: retentionPolicy,
    immutableAuditConfigured: !!process.env.AUDIT_ARCHIVE_BUCKET,
    alertDeliveryVerified: false,
    independentPenTest: 'pending',
    targetDatabaseValidation: 'required for each artefact',
  }); } catch (error) { next(error); }
});
export default router;
