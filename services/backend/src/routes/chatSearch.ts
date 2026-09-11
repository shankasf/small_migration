import { Router } from 'express';
import { requireInternalKey } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { PolicyError, screenPayload } from '../services/aiService.js';
import { searchChatHistory } from '../services/chatSearch.js';
import { searchFiles } from '../services/fileLibrary.js';

const router = Router();
router.post('/:sessionId', requireInternalKey, async (req, res) => {
  const { user_id: actorId, operation, args = {} } = req.body || {};
  if (typeof actorId !== 'string' || !['history', 'files'].includes(operation) ||
      !args || typeof args !== 'object' || Array.isArray(args) ||
      typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500 ||
      !['current', 'all'].includes(args.scope) ||
      !Number.isInteger(args.offset) || args.offset < 0 || args.offset > 10000) {
    return res.status(400).json({ error: 'Invalid chat search request.' });
  }
  try {
    const prisma = req.app.locals.prisma;
    const [actor, session] = await Promise.all([
      prisma.user.findUnique({ where: { id: actorId } }),
      prisma.session.findUnique({ where: { id: req.params.sessionId } }),
    ]);
    // Discovery is personal, including for administrators. Never search another owner's chats.
    if (!actor || actor.status !== 'active' || !session || session.ownerUserId !== actor.id) {
      return res.status(403).json({ error: 'Chat search is not permitted for this session.' });
    }
    const checked = await screenPayload(args.query);
    await recordAudit(prisma, { userId: actor.id, action: 'chat.search', resource: session.id,
      detail: JSON.stringify({ operation, scope: args.scope }), ip: req.ip });
    const result = operation === 'history'
      ? await searchChatHistory(prisma, actor.id, session.id, { q: checked.message, scope: args.scope, offset: args.offset })
      : await searchFiles(prisma, actor.id, { q: checked.message, offset: args.offset,
        sessionId: args.scope === 'current' ? session.id : undefined });
    const screened = await screenPayload('', { 'chat-search.json': JSON.stringify(result) });
    res.json(JSON.parse(screened.files['chat-search.json']));
  } catch (error) {
    res.status(error instanceof PolicyError ? 422 : 503).json({ error: error instanceof PolicyError
      ? 'Chat search content was blocked by data policy.' : 'Chat search is temporarily unavailable. This does not mean there are no matching chats.' });
  }
});
export default router;
