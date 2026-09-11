import { Prisma, PrismaClient } from '@prisma/client';
import { embedSearchTexts, PolicyError, screenPayload } from './aiService.js';
import { splitFile } from './fileLibrary.js';

export async function backfillChatChunks(prisma: PrismaClient): Promise<number> {
  const messages = await prisma.message.findMany({
    where: { searchChunks: { none: {} } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 25,
    select: { id: true, content: true },
  });
  for (const message of messages) await prisma.messageSearchChunk.createMany({
    data: splitFile(message.content).map((content, ordinal) => ({ messageId: message.id, ordinal, content })),
    skipDuplicates: true,
  });
  return messages.length;
}

export async function indexNextChatChunk(prisma: PrismaClient): Promise<boolean> {
  const [chunk] = await prisma.$queryRaw<Array<{ id: string; content: string; attempts: number }>>`
    UPDATE "MessageSearchChunk" SET "indexStatus"='indexing', "retryAt"=NOW()+INTERVAL '10 minutes', attempts=attempts+1
    WHERE id=(SELECT id FROM "MessageSearchChunk" WHERE "indexStatus" IN ('pending','retry','indexing') AND "retryAt"<=NOW()
      ORDER BY "retryAt", id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, content, attempts`;
  if (!chunk) return false;
  try {
    const screened = await screenPayload('', { 'chat.txt': chunk.content });
    const vector = (await embedSearchTexts([screened.files['chat.txt']]))[0];
    await prisma.$executeRaw`UPDATE "MessageSearchChunk" SET embedding=${JSON.stringify(vector)}::vector,
      "indexStatus"='ready' WHERE id=${chunk.id}`;
  } catch (error) {
    await prisma.messageSearchChunk.updateMany({ where: { id: chunk.id }, data: {
      indexStatus: error instanceof PolicyError ? 'blocked' : 'retry',
      retryAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(chunk.attempts, 7))),
    } });
  }
  return true;
}

export function startChatIndexer(prisma: PrismaClient): () => void {
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await backfillChatChunks(prisma);
      for (let n = 0; n < 16 && !stopped; n++) if (!await indexNextChatChunk(prisma)) break;
    } catch { console.warn('[CHAT_INDEX] Worker will retry; transcript keyword search remains available'); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

// Resolve metadata live so removed source access never survives in a retrieval cache.
export async function chatFileEvidence(prisma: PrismaClient, userId: string, messageIds: string[]) {
  const [refs, outputs] = await Promise.all([
    prisma.fileReference.findMany({ where: { messageId: { in: messageIds }, asset: { session: { ownerUserId: userId } } },
      select: { messageId: true, assetId: true, filename: true, version: true, kind: true, sourceSessionId: true } }),
    prisma.generatedOutput.findMany({ where: { messageId: { in: messageIds }, session: { ownerUserId: userId } },
      select: { messageId: true, filename: true, sessionId: true, id: true } }),
  ]);
  return [...refs, ...outputs.map(o => ({ messageId: o.messageId!, filename: o.filename,
    kind: 'output', sourceSessionId: o.sessionId, outputId: o.id }))];
}

export async function historyWithFileEvidence(prisma: PrismaClient, userId: string,
  messages: Array<{ id: string; role: string; content: string }>) {
  const refs = await chatFileEvidence(prisma, userId, messages.map(m => m.id));
  return messages.map(m => {
    const files = refs.filter(r => r.messageId === m.id);
    return { role: m.role, content: m.content + (files.length ? `\n[Saved chat file references: ${JSON.stringify(files)}]` : '') };
  });
}

export async function searchChatHistory(prisma: PrismaClient, userId: string, sessionId: string,
  opts: { q: string; scope: 'current' | 'all'; offset?: number }) {
  const q = opts.q.trim().slice(0, 500);
  let vector: string | null = null;
  try { vector = JSON.stringify((await embedSearchTexts([q]))[0]); } catch { /* keyword fallback */ }
  const rows = await prisma.$queryRaw<Array<{
    messageId: string; sourceSessionId: string; sourceSessionName: string; role: string; createdAt: Date; excerpt: string;
  }>>(Prisma.sql`
    WITH allowed AS (
      SELECT m.*, s.name AS "sourceSessionName" FROM "Message" m JOIN "Session" s ON s.id=m."sessionId"
      WHERE s."ownerUserId"=${userId} ${opts.scope === 'current' ? Prisma.sql`AND s.id=${sessionId}` : Prisma.empty}
    ), chunks AS (
      SELECT m.id, c.ordinal, c.content, c.embedding FROM allowed m JOIN "MessageSearchChunk" c ON c."messageId"=m.id
      UNION ALL
      -- Older and newly saved messages are searchable before the background index catches up.
      SELECT m.id, p.ordinal, substring(m.content FROM p.ordinal*1040+1 FOR 1200), NULL::vector
      FROM allowed m CROSS JOIN LATERAL generate_series(0, greatest(0,(length(m.content)-1)/1040)) p(ordinal)
      WHERE NOT EXISTS (SELECT 1 FROM "MessageSearchChunk" c WHERE c."messageId"=m.id)
      UNION ALL
      -- Attachments are searched using live ownership checks, not cached source metadata.
      SELECT r."messageId", -1, r.filename, NULL::vector FROM "FileReference" r
      JOIN allowed m ON m.id=r."messageId" JOIN "FileAsset" a ON a.id=r."assetId"
      JOIN "Session" s ON s.id=a."sessionId" WHERE s."ownerUserId"=${userId}
      UNION ALL
      SELECT o."messageId", -1, o.filename, NULL::vector FROM "GeneratedOutput" o JOIN allowed m ON m.id=o."messageId"
      JOIN "Session" s ON s.id=o."sessionId" WHERE s."ownerUserId"=${userId}
    ), scores AS (
      SELECT *, CASE WHEN strpos(lower(content),lower(${q}))>0 THEN 1 ELSE 0 END +
        ts_rank_cd(to_tsvector('english',content),websearch_to_tsquery('english',${q})) AS lexical,
        embedding <=> ${vector}::vector AS distance
      FROM chunks
    ), lexical AS (
      SELECT id, row_number() OVER (ORDER BY max(lexical) DESC, id) AS rank FROM scores WHERE lexical>0 GROUP BY id
    ), semantic AS (
      SELECT id, row_number() OVER (ORDER BY min(distance), id) AS rank FROM scores WHERE distance<0.65 GROUP BY id
    )
    SELECT m.id AS "messageId", m."sessionId" AS "sourceSessionId", m."sourceSessionName", m.role, m."createdAt",
      (SELECT substring(content FROM greatest(1,strpos(lower(content),lower(${q}))-100) FOR 1200)
        FROM scores c WHERE c.id=m.id ORDER BY lexical DESC, distance NULLS LAST, ordinal LIMIT 1) AS excerpt
    FROM allowed m LEFT JOIN lexical l ON l.id=m.id LEFT JOIN semantic v ON v.id=m.id
    WHERE l.id IS NOT NULL OR v.id IS NOT NULL
    ORDER BY coalesce(2.0/(60+l.rank),0)+coalesce(1.0/(60+v.rank),0) DESC,
      (m."sessionId"=${sessionId}) DESC, m."createdAt" DESC, m.id
    LIMIT 11 OFFSET ${opts.offset || 0}`);
  const page = rows.slice(0, 10);
  const files = await chatFileEvidence(prisma, userId, page.map(r => r.messageId));
  const pending = await prisma.message.count({ where: { session: { ownerUserId: userId },
    ...(opts.scope === 'current' ? { sessionId } : {}),
    OR: [{ searchChunks: { none: {} } }, { searchChunks: { some: { indexStatus: { not: 'ready' } } } }],
  } });
  return { matches: page.map(row => ({ ...row, files: files.filter(f => f.messageId === row.messageId) })),
    hasMore: rows.length > 10, nextOffset: rows.length > 10 ? (opts.offset || 0) + 10 : null,
    semanticAvailable: vector !== null, semanticIndexComplete: pending === 0, scope: opts.scope };
}
