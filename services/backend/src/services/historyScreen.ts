import { PrismaClient } from '@prisma/client';
import { recordAudit } from './audit.js';

/** One earlier turn the AI service left out of (or clipped in) the model's context. */
export interface HistoryNotice {
  index: number;
  role?: string;
  action: 'omitted' | 'clipped';
  reasons?: string[];
  original_chars?: number;
}

const NOTICE_ACTION = 'chat.history_omitted';

/** The sentence shown to the user; '' when there is nothing new to say. */
export function historyNoticeText(notices: HistoryNotice[]): string {
  const omitted = notices.filter(n => n.action === 'omitted').length;
  const clipped = notices.filter(n => n.action === 'clipped').length;
  const parts: string[] = [];
  if (omitted) parts.push(`${omitted} earlier message${omitted === 1 ? ' was' : 's were'} left out of my context because the security filter flagged ${omitted === 1 ? 'it' : 'them'}`);
  if (clipped) parts.push(`${clipped} earlier message${clipped === 1 ? ' was' : 's were'} too long, so only the start of ${clipped === 1 ? 'it' : 'each'} was used`);
  if (!parts.length) return '';
  return `Note: ${parts.join('; ')}. The rest of this chat was used as normal — repeat anything from ${omitted + clipped === 1 ? 'that message' : 'those messages'} I should still take into account.`;
}

/**
 * Notices for saved messages the user has not been told about yet. The AI
 * service re-screens history on every turn, so the same omitted message comes
 * back each time; an audit marker keyed on the message id makes the notice
 * one-time without a schema change.
 */
export async function unannouncedHistoryNotices(prisma: PrismaClient, messages: Array<{ id: string }>,
  notices: HistoryNotice[] | undefined): Promise<Array<HistoryNotice & { messageId: string }>> {
  const withIds = (notices || [])
    .map(n => ({ ...n, messageId: messages[n.index]?.id }))
    .filter((n): n is HistoryNotice & { messageId: string } => typeof n.messageId === 'string');
  if (!withIds.length) return [];
  const told = await prisma.auditEvent.findMany({
    where: { action: NOTICE_ACTION, resource: { in: withIds.map(n => n.messageId) } }, select: { resource: true },
  });
  const seen = new Set(told.map(t => t.resource));
  return withIds.filter(n => !seen.has(n.messageId));
}

/**
 * Record that the user was told. Called only after the reply carrying the note
 * was saved (a failed turn must tell them next time), and never allowed to fail
 * the turn: the worst case of a lost marker is the note appearing once more.
 */
export async function markHistoryNoticesAnnounced(prisma: PrismaClient, userId: string, sessionId: string,
  notices: Array<HistoryNotice & { messageId: string }>, ip?: string): Promise<void> {
  for (const notice of notices) {
    try {
      await recordAudit(prisma, {
        userId, action: NOTICE_ACTION, resource: notice.messageId, severity: 'warning',
        detail: JSON.stringify({ type: notice.action, reasons: notice.reasons || [] }), ip,
      });
    } catch { /* recordAudit already raised the audit-failure alarm */ }
  }
}
