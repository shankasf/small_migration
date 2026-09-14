import { Router } from 'express';
import { requireInternalKey } from '../middleware/auth.js';
import { impactState, IMPACT_SOURCES, ImpactSource } from '../services/impactState.js';
import { ImpactReadError, readImpactEvidence } from '../services/impactEvidence.js';
import { screenPayload, PolicyError } from '../services/aiService.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
router.post('/:sessionId', requireInternalKey, async (req, res) => {
  const {user_id: userId, analysis_id: analysisId, source, operation, args = {}} = req.body || {};
  if (typeof userId !== 'string' || typeof analysisId !== 'string' || !IMPACT_SOURCES.includes(source) ||
      typeof operation !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
    return res.status(400).json({error: 'Invalid evidence read request.'});
  }
  try {
    const prisma = req.app.locals.prisma;
    const [user, session] = await Promise.all([
      prisma.user.findUnique({where: {id: userId}}),
      prisma.session.findUnique({where: {id: req.params.sessionId}}),
    ]);
    // Including admins: another user's chat never grants their source consent.
    const state = impactState(session?.impactState, userId);
    if (!user || user.status !== 'active' || !['admin', 'analyst'].includes(user.role) ||
        !session || session.ownerUserId !== userId || state?.id !== analysisId ||
        state.phase !== 'confirmed' || !state.sources.includes(source)) {
      return res.status(403).json({error: 'Confirm this evidence source for this analysis before reading it.'});
    }
    await recordAudit(prisma, {userId, action: 'impact.evidence.read', resource: session.id,
      detail: JSON.stringify({provider: source}), ip: req.ip});
    const result = await readImpactEvidence(prisma, userId, session.id, source as ImpactSource, operation, args);
    const checked = await screenPayload('', {'impact-evidence.json': JSON.stringify(result)});
    return res.json(JSON.parse(checked.files['impact-evidence.json']));
  } catch (error) {
    if (error instanceof ImpactReadError) return res.status(error.status).json({error: error.message});
    return res.status(error instanceof PolicyError ? 422 : 409).json({error: error instanceof PolicyError
      ? 'This evidence was blocked by data policy.'
      : 'Evidence could not be read. Check source access, selected identifiers and permissions. No conclusion about missing dependencies can be drawn.'});
  }
});
export default router;
