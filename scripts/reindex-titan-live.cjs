// Run from the deployed backend image, with its internal API and DB credentials.
// Rebuild only derived search vectors; original content and legacy vectors remain.
const assert = require('node:assert/strict');
const { PrismaClient } = require(process.cwd() + '/node_modules/@prisma/client');
const { indexNextFile, backfillFiles } = require(process.cwd() + '/dist/services/fileLibrary.js');
const { indexNextChatChunk, backfillChatChunks } = require(process.cwd() + '/dist/services/chatSearch.js');
const { embedSearchTexts } = require(process.cwd() + '/dist/services/aiService.js');
const prisma = new PrismaClient();
const deadline = Date.now() + 30 * 60 * 1000;
let lastLog = 0;
async function counts() {
  const [files] = await prisma.$queryRaw`SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE "titanIndexedAt" IS NOT NULL)::int AS indexed,
    COUNT(*) FILTER (WHERE "indexStatus"='blocked')::int AS blocked,
    COUNT(*) FILTER (WHERE "titanIndexedAt" IS NULL AND "indexStatus"<>'blocked')::int AS pending
    FROM "FileAsset"`;
  const [chats] = await prisma.$queryRaw`SELECT COUNT(*)::int AS total,
    COUNT("embeddingTitan")::int AS indexed,
    COUNT(*) FILTER (WHERE "indexStatus"='blocked')::int AS blocked,
    COUNT(*) FILTER (WHERE "embeddingTitan" IS NULL AND "indexStatus"<>'blocked')::int AS pending
    FROM "MessageSearchChunk"`;
  const [chunks] = await prisma.$queryRaw`SELECT COUNT(*)::int AS total,
    COUNT("embeddingTitan")::int AS indexed FROM "FileChunk"`;
  return { files, chats, chunks };
}
async function main() {
  const probe = await embedSearchTexts(['Synthetic migration embedding readiness check.']);
  assert.equal(probe[0].length, 1024);
  console.log(JSON.stringify({titanProgress: 'provider verified', model: 'amazon.titan-embed-text-v2:0', region: 'ap-southeast-2'}));
  while (await backfillFiles(prisma)) {}
  while (await backfillChatChunks(prisma)) {}
  // Retry pre-existing failures once now. Guardrail blocks become terminal;
  // transient provider failures keep the normal durable backoff.
  await prisma.$executeRaw`UPDATE "FileAsset" SET "retryAt"=NOW()
    WHERE "titanIndexedAt" IS NULL AND "indexStatus"='retry'`;
  await prisma.$executeRaw`UPDATE "MessageSearchChunk" SET "retryAt"=NOW()
    WHERE "embeddingTitan" IS NULL AND "indexStatus"='retry'`;
  while (Date.now() < deadline) {
    const work = await Promise.all([indexNextFile(prisma), ...Array.from({length: 3}, () => indexNextChatChunk(prisma))]);
    if (Date.now() - lastLog > 20000 || !work.some(Boolean)) {
      const state = await counts();
      if (Date.now() - lastLog > 20000) {
        console.log(JSON.stringify({titanProgress: 'reindexing', ...state})); lastLog = Date.now();
      }
      if (!state.files.pending && !state.chats.pending) {
        console.log(JSON.stringify({titanProductionCheck: 'passed', model: 'amazon.titan-embed-text-v2:0',
          dimensions: 1024, region: 'ap-southeast-2', ...state}));
        return;
      }
    }
    if (!work.some(Boolean)) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Reindexing did not complete before the deadline');
}
main().catch(error => {
  console.error(JSON.stringify({titanProductionCheck: 'failed', reason: error.code || error.name}));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
