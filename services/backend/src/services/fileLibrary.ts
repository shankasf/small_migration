import { createHash } from 'crypto';
import { FileAsset, Prisma, PrismaClient } from '@prisma/client';
import { embedSearchTexts, PolicyError, screenPayload } from './aiService.js';

export function fileSummary(filename: string, content: string): string {
  const heading = content.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' ');
  return `${filename}: ${heading}`.replace(/\s+/g, ' ').slice(0, 300);
}

// Overlap retains expressions spanning boundaries; original content is never truncated.
export function splitFile(content: string): string[] {
  const chunks: string[] = [];
  const points = Array.from(content);
  for (let start = 0; start < points.length; start += 1040) chunks.push(points.slice(start, start + 1200).join(''));
  return chunks.length ? chunks : ['(empty file)'];
}

export async function snapshotFile(prisma: PrismaClient, kind: 'upload' | 'output', file: {
  id: string; sessionId: string; filename: string; content: string; createdAt?: Date;
}): Promise<FileAsset> {
  const contentHash = createHash('sha256').update(file.content).digest('hex');
  return prisma.$transaction(async tx => {
    // Serialize version allocation across replicas, uploads and background backfill.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${file.sessionId}:${kind}:${file.filename}`}, 0))`;
    const existing = await tx.fileAsset.findUnique({ where: { kind_sourceId_contentHash: { kind, sourceId: file.id, contentHash } } });
    if (existing) return existing;
    const last = await tx.fileAsset.aggregate({ where: { sessionId: file.sessionId, kind, filename: file.filename }, _max: { version: true } });
    return tx.fileAsset.create({ data: {
      kind, sourceId: file.id, uploadedFileId: kind === 'upload' ? file.id : null, generatedOutputId: kind === 'output' ? file.id : null, sessionId: file.sessionId, filename: file.filename, content: file.content,
      contentHash, summary: fileSummary(file.filename, file.content), version: (last._max.version || 0) + 1,
      createdAt: file.createdAt,
      chunks: { create: splitFile(file.content).map((content, ordinal) => ({ content, ordinal })) },
    } });
  }, { timeout: 30000 });
}

export async function backfillFiles(prisma: PrismaClient): Promise<number> {
  // Snapshot legacy records oldest first so versions have stable chronological numbering.
  const missing = await prisma.$queryRaw<Array<{kind: 'upload' | 'output'; id: string; sessionId: string; filename: string; content: string; createdAt: Date}>>`
    SELECT * FROM (
      SELECT 'upload' AS kind, u.id, u."sessionId", u.filename, u.content, u."createdAt" FROM "UploadedFile" u
      WHERE NOT EXISTS (SELECT 1 FROM "FileAsset" a WHERE a.kind='upload' AND a."sourceId"=u.id)
      UNION ALL
      SELECT 'output' AS kind, o.id, o."sessionId", o.filename, o.content, o."createdAt" FROM "GeneratedOutput" o
      WHERE NOT EXISTS (SELECT 1 FROM "FileAsset" a WHERE a.kind='output' AND a."sourceId"=o.id)
    ) files ORDER BY "createdAt", id LIMIT 10`;
  for (const file of missing) await snapshotFile(prisma, file.kind, file);
  return missing.length;
}

export async function indexNextFile(prisma: PrismaClient): Promise<boolean> {
  const claimed = await prisma.$queryRaw<FileAsset[]>`
    UPDATE "FileAsset" SET "indexStatus"='indexing', "retryAt"=NOW()+INTERVAL '10 minutes', attempts=attempts+1
    WHERE id=(SELECT id FROM "FileAsset" WHERE ("indexStatus" IN ('pending','retry','indexing') AND "retryAt"<=NOW())
      OR ("indexStatus"='ready' AND "titanIndexedAt" IS NULL)
      ORDER BY ("indexStatus"='ready'), "createdAt", id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
  const asset = claimed[0];
  if (!asset) return false;
  try {
    // Re-screen legacy data before provider egress. Blocked files remain available only through exact reads.
    await screenPayload('', { [asset.filename]: asset.content });
    const chunks = await prisma.fileChunk.findMany({ where: { assetId: asset.id }, orderBy: { ordinal: 'asc' } });
    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16);
      const embeddings = await embedSearchTexts(batch.map(c => `${asset.filename.slice(0, 240)}\n${asset.summary}\n${c.content}`));
      await prisma.$transaction(batch.map((c, n) => prisma.$executeRaw`
        UPDATE "FileChunk" SET "embeddingTitan"=${JSON.stringify(embeddings[n])}::vector WHERE id=${c.id}`));
    }
    await prisma.fileAsset.update({ where: { id: asset.id }, data: { indexStatus: 'ready', indexedAt: new Date(), titanIndexedAt: new Date() } });
  } catch (error) {
    await prisma.fileAsset.updateMany({ where: { id: asset.id }, data: {
      indexStatus: error instanceof PolicyError ? 'blocked' : 'retry', retryAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(asset.attempts, 7))),
    } });
    console.warn('[FILE_INDEX] Indexing deferred; keyword search remains available');
  }
  return true;
}

export function startFileIndexer(prisma: PrismaClient): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await backfillFiles(prisma);
      for (let i = 0; i < 5 && !stopped; i++) if (!await indexNextFile(prisma)) break;
    } catch { console.warn('[FILE_INDEX] Worker will retry'); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

export type SearchFile = Pick<FileAsset, 'id' | 'kind' | 'filename' | 'version' | 'summary' | 'indexStatus' | 'createdAt'> & {
  sourceSessionId: string; sourceSessionName: string; excerpt: string;
};
export function interpretFileQuery(query: string, now = new Date()) {
  if (/^[^\s]+\.[A-Za-z0-9]+$/.test(query.trim())) return {text: query.trim(), kind: undefined, extension: undefined, from: undefined, to: undefined};
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let from: Date | undefined;
  let to: Date | undefined;
  if (/\byesterday\b/i.test(query)) { to = day; from = new Date(day.getTime() - 86400000); }
  else if (/\btoday\b/i.test(query)) { from = day; to = new Date(day.getTime() + 86400000); }
  const kind = /\b(generated|chatbot)\b/i.test(query) ? 'output' : /\buploaded?\b/i.test(query) ? 'upload' : undefined;
  const extension = /\bsql\b/i.test(query) ? '.sql' : undefined;
  const text = query.replace(/\b(find|show|locate|search|please|me|my|the|a|an|file|files|i|from|that|which|was|were|generated|created|chatbot|uploaded|upload|yesterday|today|sql)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { text, kind, extension, from, to };
}

export async function searchFiles(prisma: PrismaClient, userId: string, opts: { q?: string; kind?: string; from?: Date; to?: Date; offset?: number; sessionId?: string }) {
  const originalQuery = (opts.q || '').trim().slice(0, 500);
  const interpreted = interpretFileQuery(originalQuery);
  const q = interpreted.text;
  opts = {...opts, kind: opts.kind || interpreted.kind, from: opts.from || interpreted.from, to: opts.to || interpreted.to};
  let vector: string | null = null;
  if (q) {
    try { vector = JSON.stringify((await embedSearchTexts([q]))[0]); }
    catch { /* Explicit response flag exposes keyword-only operation. */ }
  }
  const scope = Prisma.sql`s."ownerUserId"=${userId}
    ${opts.sessionId ? Prisma.sql`AND s.id=${opts.sessionId}` : Prisma.empty}
    ${opts.kind ? Prisma.sql`AND a.kind=${opts.kind}` : Prisma.empty}
    ${interpreted.extension ? Prisma.sql`AND right(lower(a.filename), length(${interpreted.extension}))=${interpreted.extension}` : Prisma.empty}
    ${opts.from ? Prisma.sql`AND a."createdAt">=${opts.from}` : Prisma.empty}
    ${opts.to ? Prisma.sql`AND a."createdAt"<${opts.to}` : Prisma.empty}`;
  // Exact vector search on the authorized subset avoids approximate-index postfilter recall loss.
  // Weighted reciprocal rank fusion keeps keyword and vector scores comparable.
  const files = await prisma.$queryRaw<SearchFile[]>(Prisma.sql`
    WITH allowed AS (
      SELECT a.*, s.name AS "sourceSessionName" FROM "FileAsset" a JOIN "Session" s ON s.id=a."sessionId" WHERE ${scope}
    ), lexical_scores AS (
      SELECT a.id, a."createdAt", CASE WHEN strpos(lower(a.filename), lower(${q}))>0 THEN 1 ELSE 0 END AS name_match,
        ts_rank_cd(to_tsvector('simple', a.filename || ' ' || a.summary), websearch_to_tsquery('simple', ${q})) +
        COALESCE(MAX(ts_rank_cd(to_tsvector('simple', c.content), websearch_to_tsquery('simple', ${q}))), 0) AS score
      FROM allowed a LEFT JOIN "FileChunk" c ON c."assetId"=a.id
      WHERE ${q}<>'' AND (strpos(lower(a.filename), lower(${q}))>0 OR
        to_tsvector('simple', a.filename || ' ' || a.summary) @@ websearch_to_tsquery('simple', ${q}) OR
        to_tsvector('simple', c.content) @@ websearch_to_tsquery('simple', ${q}))
      GROUP BY a.id, a."createdAt", a.filename, a.summary
    ), lexical AS (
      SELECT id, row_number() OVER (ORDER BY name_match DESC, score DESC, "createdAt" DESC) AS rank FROM lexical_scores
    ), semantic AS (
      SELECT id, row_number() OVER (ORDER BY distance, "createdAt" DESC) AS rank FROM (
        SELECT a.id, a."createdAt", MIN(c."embeddingTitan" <=> ${vector}::vector) AS distance
        FROM allowed a JOIN "FileChunk" c ON c."assetId"=a.id
        WHERE ${vector}::vector IS NOT NULL AND a."indexStatus"='ready' AND a."titanIndexedAt" IS NOT NULL AND c."embeddingTitan" IS NOT NULL
        GROUP BY a.id, a."createdAt"
      ) distances WHERE distance < 0.85
    )
    SELECT a.id,a.kind,a.filename,a.version,a.summary,a."indexStatus",a."createdAt",
      a."sessionId" AS "sourceSessionId",a."sourceSessionName",
      COALESCE((SELECT substring(c.content, greatest(1, strpos(lower(c.content), lower(${q})) - 80), 420)
        FROM "FileChunk" c WHERE c."assetId"=a.id ORDER BY
        CASE WHEN ${q}<>'' AND to_tsvector('simple',c.content) @@ websearch_to_tsquery('simple',${q}) THEN 0 ELSE 1 END,
        c."embeddingTitan" <=> ${vector}::vector, c.ordinal LIMIT 1),'') AS excerpt
    FROM allowed a LEFT JOIN lexical l ON l.id=a.id LEFT JOIN semantic v ON v.id=a.id
    WHERE ${q}='' OR l.id IS NOT NULL OR v.id IS NOT NULL
    ORDER BY COALESCE(2.0/(60+l.rank),0)+COALESCE(1.0/(60+v.rank),0) DESC, a."createdAt" DESC, a.id
    LIMIT 21 OFFSET ${opts.offset || 0}`);
  const hasMore = files.length > 20;
  return { files: files.slice(0, 20), hasMore, semanticAvailable: !q || vector !== null,
    filters: {kind: opts.kind, from: opts.from, to: opts.to, extension: interpreted.extension} };
}

export async function resolveFileRefs(prisma: PrismaClient, userId: string, ids: unknown): Promise<FileAsset[]> {
  if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw Object.assign(new Error('Select up to 10 files from My Files.'), { statusCode: 400 });
  }
  const unique = [...new Set(ids as string[])];
  const files = await prisma.fileAsset.findMany({ where: { id: { in: unique }, session: { ownerUserId: userId } } });
  if (files.length !== unique.length) throw Object.assign(new Error('A selected file is unavailable or belongs to another user.'), { statusCode: 403 });
  return unique.map(id => files.find(f => f.id === id)!);
}

export function referenceData(assets: FileAsset[]) {
  return assets.map(a => ({ assetId: a.id, filename: a.filename, version: a.version, kind: a.kind, sourceSessionId: a.sessionId }));
}

export async function attachLibraryRefs<T extends { id: string }>(prisma: PrismaClient, messages: T[]) {
  const refs = await prisma.fileReference.findMany({ where: { messageId: { in: messages.map(m => m.id) } }, orderBy: { createdAt: 'asc' } });
  return messages.map(message => ({ ...message, fileRefs: refs.filter(ref => ref.messageId === message.id) }));
}
