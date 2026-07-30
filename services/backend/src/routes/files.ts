import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { AuthedRequest, canAccessSession, requireWriteAccess } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

const router = Router();

const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Ingest allowlist per the architecture doc (§5): metadata/document formats only
const ALLOWED_EXTENSIONS = new Set([
  'xlsx', 'xls', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml',
  'md', 'txt', 'sql', 'py', 'js', 'ts', 'log', 'ddl', 'env'
]);

// Reject files whose leading bytes identify an executable/binary container
const BINARY_MAGIC_PREFIXES: Array<{ bytes: number[]; label: string }> = [
  { bytes: [0x4d, 0x5a], label: 'windows-executable' },        // MZ
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'elf-executable' }, // \x7fELF
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], label: 'macho-executable' },
  { bytes: [0x25, 0x50, 0x44, 0x46], label: 'pdf' },            // %PDF (not an allowed format)
];

function validateUpload(filename: string, buffer: Buffer): string | null {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `File type .${ext} is not allowed`;
  }
  const isZipContainer = buffer[0] === 0x50 && buffer[1] === 0x4b; // PK — allowed only for xlsx
  if (isZipContainer && ext !== 'xlsx' && ext !== 'xls') {
    return 'File content does not match its extension';
  }
  for (const magic of BINARY_MAGIC_PREFIXES) {
    if (magic.bytes.every((b, i) => buffer[i] === b)) {
      return `Blocked file signature (${magic.label})`;
    }
  }
  return null;
}

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
router.post('/:sessionId/upload', requireWriteAccess, (req: Request, res: Response, next) => {
  console.log(`[UPLOAD] Received upload request for session ${req.params.sessionId}`);
  console.log(`[UPLOAD] Content-Type: ${req.headers['content-type']}`);
  console.log(`[UPLOAD] Content-Length: ${req.headers['content-length']}`);
  next();
}, upload.array('files', 10), async (req: AuthedRequest, res: Response) => {
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
    if (!canAccessSession(req.user!, session)) {
      recordAudit(prisma, {
        userId: req.user!.id, action: 'file.upload', resource: sessionId,
        decision: 'deny', severity: 'warning', ip: req.ip
      });
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    // Ingest validation: extension allowlist + magic-byte check (guardrail, §5)
    for (const file of files) {
      const rejection = validateUpload(file.originalname, file.buffer);
      if (rejection) {
        recordAudit(prisma, {
          userId: req.user!.id, action: 'guardrail.file_rejected', resource: sessionId,
          decision: 'blocked', severity: 'warning',
          detail: JSON.stringify({ filename: file.originalname, reason: rejection }),
          ip: req.ip
        });
        return res.status(400).json({ error: `${file.originalname}: ${rejection}` });
      }
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
    recordAudit(prisma, {
      userId: req.user!.id, action: 'file.upload', resource: sessionId,
      detail: JSON.stringify({ files: uploadedFiles.map(f => f.filename) }),
      ip: req.ip
    });
    res.status(201).json({ files: uploadedFiles });
  } catch (error) {
    console.error('[UPLOAD] Error uploading files:', error);
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// Get files for a session
router.get('/:sessionId', async (req: AuthedRequest, res: Response) => {
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
router.delete('/:fileId', requireWriteAccess, async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { fileId } = req.params;

    const file = await prisma.uploadedFile.findUnique({
      where: { id: fileId },
      include: { session: true }
    });
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!canAccessSession(req.user!, file.session)) {
      return res.status(403).json({ error: 'You do not have access to this file' });
    }

    await prisma.uploadedFile.delete({
      where: { id: fileId }
    });

    recordAudit(prisma, {
      userId: req.user!.id, action: 'file.delete', resource: fileId,
      detail: JSON.stringify({ filename: file.filename }), ip: req.ip
    });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Get uploaded file content as JSON (for preview)
router.get('/uploaded/:fileId/content', async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { fileId } = req.params;

    const file = await prisma.uploadedFile.findUnique({
      where: { id: fileId },
      select: { filename: true, content: true, session: true }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!canAccessSession(req.user!, file.session)) {
      return res.status(403).json({ error: 'You do not have access to this file' });
    }

    res.json({ content: file.content, filename: file.filename });
  } catch (error) {
    console.error('Error getting file content:', error);
    res.status(500).json({ error: 'Failed to get file content' });
  }
});

// Download uploaded file as attachment
router.get('/uploaded/:fileId/download', async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { fileId } = req.params;

    const file = await prisma.uploadedFile.findUnique({
      where: { id: fileId },
      select: { filename: true, content: true, session: true }
    });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!canAccessSession(req.user!, file.session)) {
      return res.status(403).json({ error: 'You do not have access to this file' });
    }

    recordAudit(prisma, {
      userId: req.user!.id, action: 'file.download', resource: fileId,
      detail: JSON.stringify({ filename: file.filename }), ip: req.ip
    });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Download generated output
router.get('/output/:outputId/download', async (req: AuthedRequest, res: Response) => {
  try {
    const prisma = getPrisma(req);
    const { outputId } = req.params;

    const output = await prisma.generatedOutput.findUnique({
      where: { id: outputId },
      include: { session: true }
    });

    if (!output) {
      return res.status(404).json({ error: 'Output not found' });
    }
    if (!canAccessSession(req.user!, output.session)) {
      return res.status(403).json({ error: 'You do not have access to this output' });
    }

    recordAudit(prisma, {
      userId: req.user!.id, action: 'output.download', resource: outputId,
      detail: JSON.stringify({ filename: output.filename }), ip: req.ip
    });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${output.filename}"`);
    res.send(output.content);
  } catch (error) {
    console.error('Error downloading output:', error);
    res.status(500).json({ error: 'Failed to download output' });
  }
});

export default router;
