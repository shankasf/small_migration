import { PrismaClient } from '@prisma/client';

/** A thumb is the whole rating vocabulary: anything else is a validation error. */
export const FEEDBACK_RATINGS = ['up', 'down'];

// A note is a short reaction, not a second transcript. The cap keeps the
// guardrail pass cheap and stops the field being used to smuggle a document.
export const MAX_NOTE_CHARS = 2000;

export interface FeedbackDto {
  rating: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toFeedbackDto(row: {
  rating: string; note: string | null; createdAt: Date; updatedAt: Date;
}): FeedbackDto {
  return {
    rating: row.rating,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One reader's own ratings for a thread, keyed by message id. Ratings are
 * private to the person who left them — only the admin portal reads across
 * users — so a transcript never carries anyone else's thumb.
 */
export async function ownFeedback(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<Map<string, FeedbackDto>> {
  const rows = await prisma.messageFeedback.findMany({ where: { sessionId, userId } });
  return new Map(rows.map(row => [row.messageId, toFeedbackDto(row)]));
}
