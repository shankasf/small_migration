import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { screenPayload, testOutput } from '../services/aiService.js';
import { AuthedRequest, canAccessSession, requireWriteAccess } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { snapshotFile } from '../services/fileLibrary.js';
import { extractUploadText, upload, uploadLimitError } from '../services/fileContext.js';

const router = Router();

const getPrisma = (req: Request): PrismaClient => req.app.locals.prisma;

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

// Upload files to session
router.post('/:sessionId/upload', requireWriteAccess, (req: Request, res: Response, next) => {
  console.log(`[UPLOAD] Received upload request for session ${req.params.sessionId}`);
  console.log(`[UPLOAD] Content-Type: ${req.headers['content-type']}`);
  console.log(`[UPLOAD] Content-Length: ${req.headers['content-length']}`);
  next();
}, (req: Request, res: Response, next) => {
  upload.array('files', 10)(req, res, err => next(err ? uploadLimitError(err) : undefined));
}, async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const { sessionId } = req.params;
    const files = req.files as Express.Multer.File[];

    console.log(`[UPLOAD] Multer parsed ${files?.length || 0} files for session ${sessionId}`);
    if (files) {
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
      await recordAudit(prisma, {
        userId: req.user!.id, action: 'file.upload', resource: sessionId,
        decision: 'deny', severity: 'warning', ip: req.ip
      });
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    // Ingest validation: extension allowlist + magic-byte check (guardrail, §5)
    for (const file of files) {
      const rejection = validateUpload(file.originalname, file.buffer);
      if (rejection) {
        await recordAudit(prisma, {
          userId: req.user!.id, action: 'guardrail.file_rejected', resource: sessionId,
          decision: 'blocked', severity: 'warning',
          detail: JSON.stringify({ filename: file.originalname, reason: rejection }),
          ip: req.ip
        });
        return res.status(400).json({ error: `${file.originalname}: ${rejection}` });
      }
    }

    console.log(`[UPLOAD] Session found, parsing ${files.length} files...`);

    // Parse all files first. Unreadable or empty files are rejected with a
    // message instead of being stored as text the AI cannot use.
    const parsed = files.map(file => {
      const { content, warnings } = extractUploadText(file.buffer, file.originalname);
      const category = categorizeFile(file.originalname);
      return { content, warnings, category, originalname: file.originalname };
    });
    const categories = new Set(parsed.map(f => f.category));
    if (categories.size !== parsed.length) {
      return res.status(400).json({ error: 'Two selected files have the same name. Rename one and upload again.' });
    }

    console.log('[UPLOAD] Upserting files to database...');
    const screened = await screenPayload('', Object.fromEntries(parsed.map(f => [f.originalname, f.content])));
    if (parsed.some(f => typeof screened.files[f.originalname] !== 'string')) {
      throw new Error('Screening response omitted an uploaded file');
    }
    // Capture the old upload before replacing it so referenced versions remain immutable.
    for (const item of parsed) {
      const old = await prisma.uploadedFile.findUnique({where: {sessionId_category: {sessionId, category: item.category}}});
      if (old) await snapshotFile(prisma, 'upload', old);
    }
    const uploadedFiles = await Promise.all(
      parsed.map(({ content, category, originalname }) =>
        prisma.uploadedFile.upsert({
          where: {
            sessionId_category: { sessionId, category }
          },
          update: {
            filename: originalname,
            content: screened.files[originalname],
          },
          create: {
            sessionId,
            filename: originalname,
            category,
            content: screened.files[originalname],
          },
          select: { id: true, filename: true, category: true, sessionId: true, content: true, createdAt: true },
        })
      )
    );

    // New versions use upload time, not the original mutable row creation time.
    for (const file of uploadedFiles) await snapshotFile(prisma, 'upload', {...file, createdAt: new Date()});
    console.log(`[UPLOAD] Successfully saved ${uploadedFiles.length} files`);
    await recordAudit(prisma, {
      userId: req.user!.id, action: 'file.upload', resource: sessionId,
      detail: JSON.stringify({ files: uploadedFiles.map(f => f.filename) }),
      ip: req.ip
    });
    // Tell the user when what the AI will read differs from what they uploaded.
    res.status(201).json({ files: uploadedFiles.map(({content, ...file}) => {
      const item = parsed.find(p => p.originalname === file.filename)!;
      const warnings = [...item.warnings];
      if (content !== item.content) warnings.push(screened.guardrail.decision === 'redacted'
        ? 'Sensitive values were redacted before saving; the AI sees the redacted text.'
        : 'Some characters (such as control characters) were removed before saving.');
      return { ...file, chars: content.length, warnings };
    }) });
  } catch (error) {
    next(error);
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
    console.error('Error getting files:', error instanceof Error ? error.name : 'unknown');
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

    await prisma.$transaction([
      prisma.fileAsset.deleteMany({where: {kind: 'upload', sourceId: fileId}}),
      prisma.uploadedFile.delete({where: {id: fileId}}),
    ]);

    await recordAudit(prisma, {
      userId: req.user!.id, action: 'file.delete', resource: fileId,
      detail: JSON.stringify({ filename: file.filename }), ip: req.ip
    });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting file:', error instanceof Error ? error.name : 'unknown');
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
    console.error('Error getting file content:', error instanceof Error ? error.name : 'unknown');
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

    await recordAudit(prisma, {
      userId: req.user!.id, action: 'file.download', resource: fileId,
      detail: JSON.stringify({ filename: file.filename }), ip: req.ip
    });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (error) {
    console.error('Error downloading file:', error instanceof Error ? error.name : 'unknown');
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

    await recordAudit(prisma, {
      userId: req.user!.id, action: 'output.download', resource: outputId,
      detail: JSON.stringify({ filename: output.filename }), ip: req.ip
    });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('X-Artifact-Status', 'draft-review-required');
    res.setHeader('Content-Disposition', `attachment; filename="${output.filename}"`);
    res.send(output.content);
  } catch (error) {
    console.error('Error downloading output:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to download output' });
  }
});

router.post('/output/:outputId/test', requireWriteAccess, async (req: AuthedRequest, res: Response, next) => {
  try {
    const prisma = getPrisma(req);
    const output = await prisma.generatedOutput.findUnique({where: {id: req.params.outputId}, include: {session: true}});
    if (!output || !canAccessSession(req.user!, output.session)) return res.status(403).json({error: 'Output unavailable'});
    const validation = await testOutput(output.content, req.body.fixture);
    await prisma.generatedOutput.update({where: {id: output.id}, data: {validation}});
    await recordAudit(prisma, {userId: req.user!.id, action: 'output.fixture_test', resource: output.id});
    res.json(validation);
  } catch (error) { next(error); }
});

router.get('/output/:outputId/validation', async (req: AuthedRequest, res: Response, next) => {
  try {
    const output = await getPrisma(req).generatedOutput.findUnique({where: {id: req.params.outputId}, include: {session: true}});
    if (!output || !canAccessSession(req.user!, output.session)) return res.status(403).json({error: 'Output unavailable'});
    res.json(output.validation || {status: 'draft', static_checks: 'required', human_approval: 'required'});
  } catch (error) { next(error); }
});

export default router;
