CREATE TABLE IF NOT EXISTS "MessageSearchChunk" (
  id TEXT PRIMARY KEY,
  "messageId" TEXT NOT NULL REFERENCES "Message"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  "indexStatus" TEXT NOT NULL DEFAULT 'pending',
  "retryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "MessageSearchChunk_messageId_ordinal_key" ON "MessageSearchChunk"("messageId", ordinal);
CREATE INDEX IF NOT EXISTS "MessageSearchChunk_indexStatus_retryAt_idx" ON "MessageSearchChunk"("indexStatus", "retryAt");
CREATE INDEX IF NOT EXISTS "MessageSearchChunk_content_fts_idx" ON "MessageSearchChunk" USING GIN (to_tsvector('english', content));
