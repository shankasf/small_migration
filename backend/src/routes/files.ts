import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as XLSX from 'xlsx';

const router = Router();

const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Derive a stable category from the filename for deduplication
function categorizeFile(filename: string): string {
  // Normalize: lowercase, strip leading dots, collapse whitespace
  return filename.toLowerCase().replace(/\s+/g, '_').trim();
}

// Parse file content based on file type
function parseFileContent(buffer: Buffer, filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';

  // Excel files
  if (ext === 'xlsx' || ext === 'xls') {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      let content = '';

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        content += `--- Sheet: ${sheetName} ---\n${csv}\n\n`;
      }

      return content;
    } catch (error) {
      console.error('Error parsing Excel file:', error);
      return buffer.toString('utf-8');
    }
  }

  // JSON files - pretty print
  if (ext === 'json') {
    try {
      const json = JSON.parse(buffer.toString('utf-8'));
      return JSON.stringify(json, null, 2);
    } catch {
      return buffer.toString('utf-8');
    }
  }

  // All other text-based files
  return buffer.toString('utf-8');
}

// Upload files to session
router.post('/:sessionId/upload', (req: Request, res: Response, next) => {
  console.log(`[UPLOAD] Received upload request for session ${req.params.sessionId}`);
  console.log(`[UPLOAD] Content-Type: ${req.headers['content-type']}`);
  console.log(`[UPLOAD] Content-Length: ${req.headers['content-length']}`);
  next();
}, upload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { sessionId } = req.params;
    const files = req.files as Express.Multer.File[];

    console.log(`[UPLOAD] Multer parsed ${files?.length || 0} files for session ${sessionId}`);
    if (files) {
      files.forEach((f, i) => console.log(`[UPLOAD]   file[${i}]: ${f.originalname} (${f.size} bytes, ${f.mimetype})`));
    }

    if (!files || files.length === 0) {
      console.log('[UPLOAD] No files in request, returning 400');
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Verify session exists
    const session = await prisma.session.findUnique({
      where: { id: sessionId }
    });

    if (!session) {
      console.log(`[UPLOAD] Session ${sessionId} not found, returning 404`);
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`[UPLOAD] Session found, parsing ${files.length} files...`);

    // Parse all files first, then upsert in parallel using compound unique key
    const parsed = files.map(file => {
      const content = parseFileContent(file.buffer, file.originalname);
      const category = categorizeFile(file.originalname);
      console.log(`[UPLOAD] Parsed ${file.originalname} -> category=${category}, content length=${content.length}`);
      return { content, category, originalname: file.originalname };
    });

    console.log('[UPLOAD] Upserting files to database...');
    const uploadedFiles = await Promise.all(
      parsed.map(({ content, category, originalname }) =>
        prisma.uploadedFile.upsert({
          where: {
            sessionId_category: { sessionId, category }
          },
          update: {
            filename: originalname,
            content,
          },
          create: {
            sessionId,
            filename: originalname,
            category,
            content,
          },
          select: { id: true, filename: true, category: true },
        })
      )
    );

    console.log(`[UPLOAD] Successfully saved ${uploadedFiles.length} files`);
    res.status(201).json({ files: uploadedFiles });
  } catch (error) {
    console.error('[UPLOAD] Error uploading files:', error);
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// Get files for a session
router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { sessionId } = req.params;

    const files = await prisma.uploadedFile.findMany({
      where: { sessionId },
      select: {
        id: true,
        filename: true,
        category: true,
        createdAt: true
      }
    });

    res.json(files);
  } catch (error) {
    console.error('Error getting files:', error);
    res.status(500).json({ error: 'Failed to get files' });
  }
});

// Delete a file
router.delete('/:fileId', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { fileId } = req.params;

    await prisma.uploadedFile.delete({
      where: { id: fileId }
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Get uploaded file content as JSON (for preview)
router.get('/uploaded/:fileId/content', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { fileId } = req.params;

    const file = await prisma.uploadedFile.findUnique({
      where: { id: fileId },
      select: { filename: true, content: true }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({ content: file.content, filename: file.filename });
  } catch (error) {
    console.error('Error getting file content:', error);
    res.status(500).json({ error: 'Failed to get file content' });
  }
});

// Download uploaded file as attachment
router.get('/uploaded/:fileId/download', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { fileId } = req.params;

    const file = await prisma.uploadedFile.findUnique({
      where: { id: fileId },
      select: { filename: true, content: true }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Download generated output
router.get('/output/:outputId/download', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { outputId } = req.params;

    const output = await prisma.generatedOutput.findUnique({
      where: { id: outputId }
    });

    if (!output) {
      return res.status(404).json({ error: 'Output not found' });
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${output.filename}"`);
    res.send(output.content);
  } catch (error) {
    console.error('Error downloading output:', error);
    res.status(500).json({ error: 'Failed to download output' });
  }
});

export default router;
