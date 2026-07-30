import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { sendToAIService } from '../services/aiService.js';
import { AuthedRequest, canAccessSession, requireWriteAccess } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { checkTokenCaps, recordUsage } from '../services/usage.js';

const router = Router();

const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

// Send message to session
router.post('/:sessionId/messages', requireWriteAccess, async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { sessionId } = req.params;
    const { message } = req.body;
    const user = req.user!;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Verify session exists and determine if this is the first message
    const isFirstMessage = await prisma.message.count({ where: { sessionId } }) === 0;

    // Always load full file content so AI service gets files even if uploaded mid-conversation
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        files: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 20
        }
      }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSession(user, session)) {
      recordAudit(prisma, {
        userId: user.id, action: 'chat.message', resource: sessionId,
        decision: 'deny', severity: 'warning', ip: req.ip
      });
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    // Enforce per-user token caps set by an admin
    const caps = await checkTokenCaps(prisma, user);
    if (!caps.allowed) {
      recordAudit(prisma, {
        userId: user.id, action: 'chat.message', resource: sessionId,
        decision: 'deny', severity: 'warning',
        detail: JSON.stringify({ reason: caps.reason }), ip: req.ip
      });
      return res.status(429).json({ error: caps.reason });
    }

    // Save user message
    const userMessage = await prisma.message.create({
      data: {
        sessionId,
        role: 'user',
        content: message
      }
    });

    // Reverse messages from desc to chronological order
    session.messages.reverse();

    // Always send files to AI service so it has them even if uploaded mid-conversation
    let files: Record<string, string> | undefined;
    if (session.files.length > 0) {
      const fileMap: Record<string, string> = {};
      for (const file of session.files) {
        if (file.content) {
          fileMap[file.filename] = file.content;
        }
      }
      if (Object.keys(fileMap).length > 0) {
        files = fileMap;
        console.log(`[CHAT] Sending ${Object.keys(fileMap).length} files to AI service: ${Object.keys(fileMap).join(', ')}`);
      }
    }

    // Prepare conversation history
    const history = session.messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Call AI service
    const aiResponse = await sendToAIService({
      session_id: sessionId,
      message,
      files,
      history
    });

    // Record token usage + cost for this user (metering for admin analytics/caps)
    if (aiResponse.usage && (aiResponse.usage.input_tokens || aiResponse.usage.output_tokens)) {
      recordUsage(prisma, {
        userId: user.id,
        sessionId,
        provider: aiResponse.usage.provider || 'openai',
        model: aiResponse.usage.model || 'unknown',
        inputTokens: aiResponse.usage.input_tokens || 0,
        outputTokens: aiResponse.usage.output_tokens || 0,
      }).catch(err => console.error('[USAGE] Failed to record usage:', err?.message || err));
    }

    // Audit the interaction, carrying the guardrail decision from the AI service
    const guardrail = aiResponse.guardrail;
    recordAudit(prisma, {
      userId: user.id,
      action: guardrail?.decision === 'blocked' ? 'guardrail.block' : 'chat.message',
      resource: sessionId,
      decision: guardrail?.decision === 'blocked' ? 'blocked' : 'allow',
      dataClass: guardrail?.data_class || 'metadata',
      severity: guardrail?.decision === 'blocked' ? 'critical'
        : guardrail?.decision === 'redacted' ? 'warning' : 'info',
      detail: guardrail ? JSON.stringify({
        decision: guardrail.decision,
        reasons: guardrail.reasons,
        findings: guardrail.findings
      }) : null,
      ip: req.ip
    });

    // Save assistant message
    const assistantMessage = await prisma.message.create({
      data: {
        sessionId,
        role: 'assistant',
        content: aiResponse.response
      }
    });

    // Save generated files if any — parallel upserts using compound unique key
    let savedOutputs: any[] = [];
    if (aiResponse.generated_files && aiResponse.generated_files.length > 0) {
      savedOutputs = await Promise.all(
        aiResponse.generated_files.map((file: any) =>
          prisma.generatedOutput.upsert({
            where: {
              sessionId_filename: { sessionId, filename: file.name }
            },
            update: {
              filepath: file.path,
              content: file.content || '',
            },
            create: {
              sessionId,
              filename: file.name,
              filepath: file.path,
              fileType: file.name.endsWith('.sql') ? 'sql' : 'txt',
              content: file.content || '',
            },
          })
        )
      );
    }

    // Update session name if it's the first message
    const sessionName = isFirstMessage
      ? message.slice(0, 50) + (message.length > 50 ? '...' : '')
      : undefined;
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        ...(sessionName ? { name: sessionName } : {}),
        updatedAt: new Date(),
      }
    });

    // Return saved DB records (with id, createdAt) so frontend can use directly
    res.json({
      userMessage,
      assistantMessage,
      generated_files: aiResponse.generated_files || [],
      savedOutputs,
      updatedSession: {
        id: sessionId,
        name: sessionName || session.name,
        updatedAt: new Date().toISOString(),
      },
      status: aiResponse.status,
      guardrail: aiResponse.guardrail
    });
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// Get messages for a session
router.get('/:sessionId/messages', async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { sessionId } = req.params;

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSession(req.user!, session)) {
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    const messages = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' }
    });

    res.json(messages);
  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

export default router;
