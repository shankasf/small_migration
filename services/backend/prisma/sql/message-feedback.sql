-- Per-response ratings. Applied ahead of the new tasks because the session
-- transcript reads this table on every thread open: a task that starts before
-- schema-sync would 500 on it.

-- CreateTable
CREATE TABLE IF NOT EXISTS "MessageFeedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MessageFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MessageFeedback_messageId_userId_key" ON "MessageFeedback"("messageId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MessageFeedback_createdAt_idx" ON "MessageFeedback"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MessageFeedback_rating_createdAt_idx" ON "MessageFeedback"("rating", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MessageFeedback_userId_createdAt_idx" ON "MessageFeedback"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MessageFeedback_sessionId_idx" ON "MessageFeedback"("sessionId");
