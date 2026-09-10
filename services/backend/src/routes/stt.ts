import { Router } from 'express';
import { requireWriteAccess } from '../middleware/auth.js';
const router = Router();
router.post('/', requireWriteAccess, (_req, res) => {
  res.status(403).json({ error: 'Voice input is unavailable until an approved transcription boundary is configured. Please type your message.' });
});
export default router;
