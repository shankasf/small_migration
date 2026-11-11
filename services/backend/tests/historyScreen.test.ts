// DB-free tests for the one-time "earlier message left out" notice. A fake
// Prisma stands in for the audit table. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  historyNoticeText, markHistoryNoticesAnnounced, unannouncedHistoryNotices, type HistoryNotice,
} from '../src/services/historyScreen.js';

function fakePrisma(opts: { failWrites?: boolean } = {}) {
  const rows: Array<{ action: string; resource: string | null }> = [];
  return {
    rows,
    auditEvent: {
      async findMany({ where }: any) {
        return rows.filter(r => r.action === where.action && where.resource.in.includes(r.resource))
          .map(r => ({ resource: r.resource }));
      },
      async create({ data }: any) {
        if (opts.failWrites) throw new Error('db down');
        rows.push({ action: data.action, resource: data.resource });
        return data;
      },
    },
  } as any;
}

const messages = [{ id: 'm-0' }, { id: 'm-1' }, { id: 'm-2' }];
const omitted: HistoryNotice = { index: 1, role: 'assistant', action: 'omitted', reasons: ['prompt_injection'] };
const clipped: HistoryNotice = { index: 2, role: 'user', action: 'clipped', reasons: ['history_message_too_large'], original_chars: 600000 };

test('notice text says what was left out and that the chat continues', () => {
  assert.equal(historyNoticeText([]), '');
  const one = historyNoticeText([omitted]);
  assert.match(one, /1 earlier message was left out of my context because the security filter flagged it/);
  assert.match(one, /rest of this chat was used as normal/);
  const both = historyNoticeText([omitted, clipped]);
  assert.match(both, /too long, so only the start of it was used/);
  assert.match(both, /those messages/);
});

test('the user is told once per message, then never again', async () => {
  const prisma = fakePrisma();
  const first = await unannouncedHistoryNotices(prisma, messages, [omitted]);
  assert.deepEqual(first.map(n => n.messageId), ['m-1']);
  await markHistoryNoticesAnnounced(prisma, 'user-1', 'session-1', first);
  // Same message comes back as omitted on every later turn: no second notice.
  assert.deepEqual(await unannouncedHistoryNotices(prisma, messages, [omitted]), []);
  // A different message omitted later is still announced.
  const later = await unannouncedHistoryNotices(prisma, messages, [omitted, clipped]);
  assert.deepEqual(later.map(n => n.messageId), ['m-2']);
});

test('notices are not marked when the turn never saved its reply', async () => {
  const prisma = fakePrisma();
  await unannouncedHistoryNotices(prisma, messages, [omitted]);  // turn fails before markHistoryNoticesAnnounced
  assert.equal((await unannouncedHistoryNotices(prisma, messages, [omitted])).length, 1);
});

test('a failed audit write never fails the turn', async () => {
  const prisma = fakePrisma({ failWrites: true });
  const pending = await unannouncedHistoryNotices(prisma, messages, [omitted]);
  await markHistoryNoticesAnnounced(prisma, 'user-1', 'session-1', pending);
  assert.equal(prisma.rows.length, 0);
});

test('missing or out-of-range notices are ignored', async () => {
  const prisma = fakePrisma();
  assert.deepEqual(await unannouncedHistoryNotices(prisma, messages, undefined), []);
  assert.deepEqual(await unannouncedHistoryNotices(prisma, messages, [{ ...omitted, index: 9 }]), []);
});
