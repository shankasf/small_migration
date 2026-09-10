import { Router, Response } from 'express';
import { AuthedRequest, requireRole } from '../middleware/auth.js';
import { resolveFileRefs, searchFiles } from '../services/fileLibrary.js';
import { recordAudit } from '../services/audit.js';

const router = Router();
router.use(requireRole('admin', 'analyst'));
router.get('/', async (req: AuthedRequest, res: Response, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const offset = Number(req.query.offset || 0);
    if (q.length > 500 || (kind && !['upload', 'output'].includes(kind)) ||
      (from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) ||
      (from && to && from >= to) || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
      return res.status(400).json({ error: 'Invalid file search filters' });
    }
    res.json(await searchFiles(req.app.locals.prisma, req.user!.id, { q, kind, from, to, offset }));
  } catch (error) { next(error); }
});
router.get('/:id/content', async (req: AuthedRequest, res: Response, next) => {
  try {
    const [file] = await resolveFileRefs(req.app.locals.prisma, req.user!.id, [req.params.id]);
    res.json({ filename: file.filename, content: file.content, version: file.version });
  } catch (error) { next(error); }
});
router.get('/:id/download', async (req: AuthedRequest, res: Response, next) => {
  try {
    const [file] = await resolveFileRefs(req.app.locals.prisma, req.user!.id, [req.params.id]);
    await recordAudit(req.app.locals.prisma, { userId: req.user!.id, action: 'library.download', resource: file.id,
      detail: JSON.stringify({ version: file.version }) });
    res.attachment(file.filename).type('text/plain').send(file.content);
  } catch (error) { next(error); }
});
export default router;
