-- CreateTable
CREATE TABLE IF NOT EXISTS "FileAsset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "uploadedFileId" TEXT,
    "generatedOutputId" TEXT,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "indexStatus" TEXT NOT NULL DEFAULT 'pending',
    "indexedAt" TIMESTAMP(3),
    "retryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAsset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_uploadedFileId_fkey" FOREIGN KEY ("uploadedFileId") REFERENCES "UploadedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_generatedOutputId_fkey" FOREIGN KEY ("generatedOutputId") REFERENCES "GeneratedOutput"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FileChunk" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "FileChunk_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FileAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FileReference" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "assetId" TEXT,
    "filename" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileReference_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileReference_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FileReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FileAsset_sessionId_createdAt_idx" ON "FileAsset"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FileAsset_indexStatus_retryAt_idx" ON "FileAsset"("indexStatus", "retryAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FileAsset_kind_sourceId_contentHash_key" ON "FileAsset"("kind", "sourceId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FileAsset_sessionId_kind_filename_version_key" ON "FileAsset"("sessionId", "kind", "filename", "version");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FileChunk_assetId_ordinal_key" ON "FileChunk"("assetId", "ordinal");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FileReference_messageId_idx" ON "FileReference"("messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FileReference_assetId_idx" ON "FileReference"("assetId");






-- Keep exact identifiers searchable alongside semantic chunks.
CREATE INDEX IF NOT EXISTS "FileAsset_metadata_fts_idx" ON "FileAsset"
USING GIN (to_tsvector('simple', filename || ' ' || summary));

CREATE INDEX IF NOT EXISTS "FileChunk_content_fts_idx" ON "FileChunk" USING GIN (to_tsvector('simple', content));
