-- Additive migration: old tasks can finish without mixing vector spaces.
ALTER TABLE "FileChunk" ADD COLUMN IF NOT EXISTS "embeddingTitan" vector(1024);
ALTER TABLE "MessageSearchChunk" ADD COLUMN IF NOT EXISTS "embeddingTitan" vector(1024);
ALTER TABLE "FileAsset" ADD COLUMN IF NOT EXISTS "titanIndexedAt" TIMESTAMP(3);
