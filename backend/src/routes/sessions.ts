import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();

// Get prisma from app locals
const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

// Create new session
router.post('/', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { name } = req.body;

    const session = await prisma.session.create({
      data: {
        name: name || 'New Chat'
      }
    });

    res.status(201).json(session);
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// List sessions with cursor-based pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const cursor = req.query.cursor as string | undefined;

    const sessions = await prisma.session.findMany({
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
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Get single session with messages
router.get('/:id', async (req: Request, res: Response) => {
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
          select: { id: true, filename: true, filepath: true, fileType: true, createdAt: true, sessionId: true },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(session);
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Update session name
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { id } = req.params;
    const { name } = req.body;

    const session = await prisma.session.update({
      where: { id },
      data: { name }
    });

    res.json(session);
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// Delete session
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { id } = req.params;

    await prisma.session.delete({
      where: { id }
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Get session outputs
router.get('/:id/outputs', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { id } = req.params;

    const outputs = await prisma.generatedOutput.findMany({
      where: { sessionId: id },
      select: { id: true, filename: true, filepath: true, fileType: true, createdAt: true, sessionId: true },
      orderBy: { createdAt: 'desc' }
    });

    res.json(outputs);
  } catch (error) {
    console.error('Error getting outputs:', error);
    res.status(500).json({ error: 'Failed to get outputs' });
  }
});

export default router;
