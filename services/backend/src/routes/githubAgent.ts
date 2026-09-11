import { Router } from 'express';
import axios from 'axios';
import { canAccessSession, requireInternalKey } from '../middleware/auth.js';
import { GitHubReadError, readGitHub } from '../services/githubAgent.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
// Mounted before public user auth, but never without the shared internal guard.
router.post('/:sessionId', requireInternalKey, async (req, res) => {
  const { user_id: actorId, operation, args = {} } = req.body || {};
  if (typeof actorId !== 'string' || typeof operation !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
    return res.status(400).json({ error: 'Invalid internal GitHub request.' });
  }
  try {
    const prisma = req.app.locals.prisma;
    const [actor, session] = await Promise.all([
      prisma.user.findUnique({ where: { id: actorId } }),
      prisma.session.findUnique({ where: { id: req.params.sessionId }, select: { ownerUserId: true } }),
    ]);
    if (!actor || actor.status !== 'active' || !session || !canAccessSession(actor, session)) {
      return res.status(403).json({ error: 'GitHub access for this chat is not permitted.' });
    }
    // Always the authenticated actor's connection, including when an admin views another user's chat.
    await recordAudit(prisma, { userId: actor.id, action: 'integration.github.read', resource: req.params.sessionId,
      detail: JSON.stringify({ operation }), ip: req.ip });
    res.json(await readGitHub(prisma, actor.id, operation, args));
  } catch (error) {
    if (error instanceof GitHubReadError) return res.status(error.status).json({ error: error.message });
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    // Never serialize provider request/error objects: they contain credentials.
    return res.status(status === 404 ? 404 : 409).json({ error: status === 404
      ? 'GitHub repository, branch, or file was not found or access was removed.'
      : 'GitHub access could not be verified. Check your connection and repository permissions in Settings → Integrations.' });
  }
});
export default router;
