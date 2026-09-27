import { PrismaClient } from '@prisma/client';

/** A thumb is the whole rating vocabulary: anything else is a validation error. */
export const FEEDBACK_RATINGS = ['up', 'down'];

// A thumbs up can be graded on a 1-5 rubric (the level wording lives with the
// widget). A thumbs down is already the bottom of the scale, so it carries none.
export const MIN_SCORE = 1;
export const MAX_SCORE = 5;
export const isRubricScore = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= MIN_SCORE && (value as number) <= MAX_SCORE;

// A note is a short reaction, not a second transcript. The cap keeps the
// guardrail pass cheap and stops the field being used to smuggle a document.
export const MAX_NOTE_CHARS = 2000;

export interface FeedbackDto {
  rating: string;
  score: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toFeedbackDto(row: {
  rating: string; score: number | null; note: string | null; createdAt: Date; updatedAt: Date;
}): FeedbackDto {
  return {
    rating: row.rating,
    score: row.score,
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
