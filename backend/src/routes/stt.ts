import { Router, Request, Response } from 'express';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';

const router = Router();

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8084';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max for Whisper
});

// Proxy audio to AI service STT endpoint
router.post('/', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const form = new FormData();
    form.append('audio', file.buffer, {
      filename: file.originalname || 'recording.webm',
      contentType: file.mimetype || 'audio/webm',
    });

    const response = await axios.post(`${AI_SERVICE_URL}/ai/stt`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });

    res.json(response.data);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('STT error:', error.response?.data || error.message);
      const status = error.response?.status || 500;
      return res.status(status).json({ error: error.response?.data?.detail || 'Transcription failed' });
    }
    console.error('STT error:', error);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

export default router;
