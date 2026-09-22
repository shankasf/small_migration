import { Router } from 'express';
import { requireInternalKey } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { PolicyError, screenPayload } from '../services/aiService.js';
import { searchChatHistory } from '../services/chatSearch.js';
import { resolveFileRefs, searchFiles } from '../services/fileLibrary.js';

// A discovered file is delivered back through the assistant's reply, so it has
// to fit in one chat response alongside it.
const MAX_DELIVERABLE_CHARS = 400_000;

const SEARCHES = ['history', 'files'];
const UUID = /^[0-9a-f-]{36}$/i;

function isValidRequest(actorId: unknown, operation: unknown, args: any): boolean {
  if (typeof actorId !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (operation === 'fetch') return typeof args.id === 'string' && UUID.test(args.id);
  return typeof operation === 'string' && SEARCHES.includes(operation) &&
    typeof args.query === 'string' && !!args.query.trim() && args.query.length <= 500 &&
    ['current', 'all'].includes(args.scope) &&
    Number.isInteger(args.offset) && args.offset >= 0 && args.offset <= 10000;
}

const router = Router();
router.post('/:sessionId', requireInternalKey, async (req, res) => {
  const { user_id: actorId, operation, args = {} } = req.body || {};
  if (!isValidRequest(actorId, operation, args)) {
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
    // Delivering a file the user already owns into their own chat: the same
    // ownership rule as @-mentioning it, and audited as its own action.
    if (operation === 'fetch') {
      const [asset] = await resolveFileRefs(prisma, actor.id, [args.id]);
      await recordAudit(prisma, { userId: actor.id, action: 'chat.file.attach', resource: session.id,
        detail: JSON.stringify({ assetId: asset.id, filename: asset.filename, version: asset.version,
          sourceSessionId: asset.sessionId }), ip: req.ip });
      if (asset.content.length > MAX_DELIVERABLE_CHARS) {
        return res.status(413).json({ error: `${asset.filename} is too large to attach to a reply. `
          + 'Ask the user to open it from My Files.' });
      }
      const checkedFile = await screenPayload('', { 'chat-file': asset.content });
      return res.json({ id: asset.id, filename: asset.filename, version: asset.version, kind: asset.kind,
        sourceSessionId: asset.sessionId, content: checkedFile.files['chat-file'] });
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
    // An unowned or unknown file id is the caller's fault, not an outage.
    const statusCode = (error as any)?.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({ error: (error as Error).message });
    }
    res.status(error instanceof PolicyError ? 422 : 503).json({ error: error instanceof PolicyError
      ? 'Chat search content was blocked by data policy.' : 'Chat search is temporarily unavailable. This does not mean there are no matching chats.' });
  }
});
export default router;
