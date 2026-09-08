import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthedRequest, canAccessSession, requireRole, requireWriteAccess } from '../middleware/auth.js';
import { screenPayload, resetAISession } from '../services/aiService.js';
import { recordAudit } from '../services/audit.js';

const router = Router();

// Get prisma from app locals
const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

// Create new session (owned by the caller)
router.post('/', requireWriteAccess, async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const { name } = req.body;

    const session = await prisma.session.create({
      data: {
        name: (await screenPayload(typeof name === 'string' ? name : 'New Chat')).message,
        ownerUserId: req.user!.id
      }
    });

    await recordAudit(prisma, {
      userId: req.user!.id,
      action: 'session.create',
      resource: session.id,
      ip: req.ip
    });
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

// List sessions with cursor-based pagination.
// Admins see all sessions; analysts see only their own (row-level scoping).
router.get('/', requireRole('admin', 'analyst'), async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const cursor = req.query.cursor as string | undefined;
    const user = req.user!;

    const sessions = await prisma.session.findMany({
      ...(user.role === 'admin' ? {} : { where: { ownerUserId: user.id } }),
      ...(cursor ? {
        skip: 1,
        cursor: { id: cursor },
      } : {}),
      take: limit + 1, // Fetch one extra to determine if there are more
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' }
        },
        _count: {
          select: { messages: true, files: true, outputs: true }
        }
      }
    });

    const hasMore = sessions.length > limit;
    const results = hasMore ? sessions.slice(0, limit) : sessions;
    const nextCursor = hasMore ? results[results.length - 1].id : null;

    res.json({ sessions: results, nextCursor });
  } catch (error) {
    console.error('Error listing sessions:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Get single session with messages
router.get('/:id', async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const { id } = req.params;

    const session = await prisma.session.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' }
        },
        files: {
          select: { id: true, filename: true, category: true, createdAt: true, sessionId: true },
          orderBy: { createdAt: 'asc' }
        },
        outputs: {
          select: { id: true, filename: true, filepath: true, fileType: true, createdAt: true, sessionId: true, messageId: true },
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSession(req.user!, session)) {
      await recordAudit(prisma, {
        userId: req.user!.id,
        action: 'session.access',
        resource: id,
        decision: 'deny',
        severity: 'warning',
        ip: req.ip
      });
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    res.json(session);
  } catch (error) {
    console.error('Error getting session:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Update session name
router.patch('/:id', requireWriteAccess, async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const { id } = req.params;
    const { name } = req.body;

    const existing = await prisma.session.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSession(req.user!, existing)) {
      await recordAudit(prisma, {
        userId: req.user!.id, action: 'session.update', resource: id,
        decision: 'deny', severity: 'warning', ip: req.ip
      });
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    const session = await prisma.session.update({
      where: { id },
      data: { name: (await screenPayload(typeof name === "string" ? name : "New Chat")).message }
    });

    await recordAudit(prisma, { userId: req.user!.id, action: 'session.update', resource: id, ip: req.ip });
    res.json(session);
  } catch (error) {
    next(error);
  }
});

// Delete session
router.delete('/:id', requireWriteAccess, async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const { id } = req.params;

    const existing = await prisma.session.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSession(req.user!, existing)) {
      await recordAudit(prisma, {
        userId: req.user!.id, action: 'session.delete', resource: id,
        decision: 'deny', severity: 'warning', ip: req.ip
      });
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    await resetAISession(id);
    req.app.locals.io?.in(`session:${id}`).disconnectSockets(true);
    await prisma.aiActivityLog.deleteMany({ where: { sessionId: id } });
    await prisma.session.delete({
      where: { id }
    });

    await recordAudit(prisma, { userId: req.user!.id, action: 'session.delete', resource: id, ip: req.ip });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting session:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Get session outputs
router.get('/:id/outputs', async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const { id } = req.params;

    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSession(req.user!, session)) {
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    const outputs = await prisma.generatedOutput.findMany({
      where: { sessionId: id },
      select: { id: true, filename: true, filepath: true, fileType: true, createdAt: true, sessionId: true, messageId: true },
      orderBy: { createdAt: 'asc' }
    });

    res.json(outputs);
  } catch (error) {
    console.error('Error getting outputs:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to get outputs' });
  }
});

export default router;
