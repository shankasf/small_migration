import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthedRequest, canAccessSession, requireWriteAccess } from '../middleware/auth.js';
import { screenPayload } from '../services/aiService.js';
import { recordAudit, recordDeniedAudit } from '../services/audit.js';
import { FEEDBACK_RATINGS, MAX_NOTE_CHARS, MAX_SCORE, MIN_SCORE, isRubricScore, toFeedbackDto } from '../services/feedback.js';

const router = Router();
const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

/**
 * Ratings live on assistant messages only, and only for someone who can read
 * the thread they belong to — the same row-level scoping the transcript uses,
 * so an analyst cannot rate (or probe for) another analyst's session.
 */
async function authorizeRating(req: AuthedRequest, res: Response) {
  const prisma = getPrisma(req);
  const user = req.user!;
  const message = await prisma.message.findUnique({
    where: { id: req.params.messageId },
    include: { session: { select: { id: true, ownerUserId: true } } },
  });
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return null;
  }
  if (!canAccessSession(user, message.session)) {
    await recordDeniedAudit(prisma, {
      userId: user.id, action: 'chat.feedback', resource: message.id,
      decision: 'deny', severity: 'warning', ip: req.ip,
    });
    res.status(403).json({ error: 'You do not have access to this session' });
    return null;
  }
  if (message.role !== 'assistant') {
    res.status(400).json({ error: 'Only assistant responses can be rated' });
    return null;
  }
  return { prisma, user, message };
}

// Rate an assistant response, optionally with a rubric score and a note. All
// three are idempotent: re-rating replaces the thumb, and `score` / `note` are
// only touched when the caller sends the key — so saving a note never disturbs
// the rating and switching the thumb never drops the note. The score is the
// exception by design: it grades a thumbs up, so switching to down clears it.
router.put('/messages/:messageId', requireWriteAccess, async (req: AuthedRequest, res: Response, next) => {
  try {
    const authorized = await authorizeRating(req, res);
    if (!authorized) return;
    const { prisma, user, message } = authorized;
    const { rating, note, score } = req.body || {};

    if (!FEEDBACK_RATINGS.includes(rating)) {
      return res.status(400).json({ error: `Rating must be one of: ${FEEDBACK_RATINGS.join(', ')}` });
    }
    if (score !== undefined && score !== null && !isRubricScore(score)) {
      return res.status(400).json({ error: `Score must be a whole number from ${MIN_SCORE} to ${MAX_SCORE}` });
    }
    if (isRubricScore(score) && rating !== 'up') {
      return res.status(400).json({ error: 'A rubric score can only accompany a thumbs up' });
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return res.status(400).json({ error: 'Note must be text' });
    }
    if (typeof note === 'string' && note.length > MAX_NOTE_CHARS) {
      return res.status(400).json({ error: `Note must be ${MAX_NOTE_CHARS} characters or fewer` });
    }

    // A note is free user text, so it crosses the same policy boundary as a
    // chat message before it is stored: blocked content never lands in the
    // table, and anything redactable is stored redacted.
    const trimmed = typeof note === 'string' ? note.trim() : note;
    const screened = trimmed ? await screenPayload(trimmed) : null;
    const data = {
      rating,
      ...(rating !== 'up' ? { score: null } : score === undefined ? {} : { score }),
      ...(note === undefined ? {} : { note: screened ? screened.message : null }),
    };

    // One upsert on the (message, user) key: two saves racing for the first
    // rating (a thumb and its score) can no longer both try to create the row.
    const row = await prisma.messageFeedback.upsert({
      where: { messageId_userId: { messageId: message.id, userId: user.id } },
      update: data,
      create: { messageId: message.id, userId: user.id, sessionId: message.sessionId, score: null, note: null, ...data },
    });

    await recordAudit(prisma, {
      userId: user.id,
      action: 'chat.feedback',
      resource: message.id,
      dataClass: screened?.guardrail?.data_class || 'metadata',
      severity: screened?.guardrail?.decision === 'redacted' ? 'warning' : 'info',
      detail: JSON.stringify({
        decision: screened?.guardrail?.decision || 'allow',
        rating: row.rating,
        ...(row.score ? { score: row.score } : {}),
        ...(screened?.guardrail?.reasons ? { reasons: screened.guardrail.reasons } : {}),
      }),
      ip: req.ip,
    });
    res.json(toFeedbackDto(row));
  } catch (error) { next(error); }
});

// Withdraw a rating. Clearing the thumb clears the note with it: the note only
// ever existed as the reason for a verdict the user has now taken back.
router.delete('/messages/:messageId', requireWriteAccess, async (req: AuthedRequest, res: Response, next) => {
  try {
    const authorized = await authorizeRating(req, res);
    if (!authorized) return;
    const { prisma, user, message } = authorized;
    await prisma.messageFeedback.deleteMany({ where: { messageId: message.id, userId: user.id } });
    await recordAudit(prisma, {
      userId: user.id, action: 'chat.feedback_withdrawn', resource: message.id, ip: req.ip,
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

export default router;
