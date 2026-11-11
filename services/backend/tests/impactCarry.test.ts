// Silent context loss: a complaint must not replace the pending impact request, and an
// admin continuing another user's chat keeps its carried files. Synthetic data only.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { impactBrief, isNewAnalysisRequest, requestImpactSources } from '../src/services/impactState.js';
import { accessibleCarried, carriedAssetIds } from '../src/services/fileContext.js';
process.env.JWT_SECRET = process.env.JWT_SECRET || randomBytes(40).toString('hex');
// The real access rule; auth.ts needs JWT_SECRET at import time.
let canAccessSession: (user: any, session: { ownerUserId: string | null }) => boolean;
before(async () => { ({ canAccessSession } = await import('../src/middleware/auth.js')); });

const REQUEST = 'Trace the impact of changing Losartan cost to $15 on rep_dispensing';
const pending = () => requestImpactSources('alice', REQUEST, new Date());

test('a complaint while sources are pending keeps the original analysis request exactly', () => {
  for (const reply of [
    'are you not able to read the file?', "why can't you trace the impact?", 'why can’t you trace the impact?',
    'you still did not answer', "you didn't change anything", 'can you not see what I attached?',
    'This is not working, try again', "can't you read the file I attached?",
  ]) assert.equal(impactBrief(pending(), reply), REQUEST, reply);
});

test('other unclassified replies while pending keep the original first, with the reply as a follow-up', () => {
  for (const reply of [
    'ok', 'thanks', 'just do the impact analysis', 'where is the impact report?', 'still waiting for the trace',
    'now do the same for Metformin', 'I already told you',
  ]) assert.equal(impactBrief(pending(), reply), `${REQUEST}\n\nFollow-up: ${reply}`, reply);
});

test('a genuinely new analysis request replaces the pending one', () => {
  for (const ask of [
    'What breaks if I drop customer_count from customer_mart?',
    'Can you trace the lineage of stg_orders?',
    'What happens downstream if we rename order_total to gross_total?',
    'Which dashboards depend on fct_revenue?',
    'what if order_total becomes nullable?',
  ]) {
    assert.ok(isNewAnalysisRequest(ask), ask);
    assert.equal(impactBrief(pending(), ask), ask, ask);
  }
});

test('source replies still refine the pending request, and nothing pending means the message is the request', () => {
  assert.equal(impactBrief(pending(), '#3 github repositories'), `${REQUEST}\n\nFollow-up: #3 github repositories`);
  assert.equal(impactBrief(pending(), 'can you not read the github repo?'), `${REQUEST}\n\nFollow-up: can you not read the github repo?`);
  assert.equal(impactBrief(null, 'are you not able to read the file?'), 'are you not able to read the file?');
});

test('after a confirmed analysis a complaint keeps the request but a new question starts over', () => {
  const confirmed = {...pending(), phase: 'confirmed' as const, sources: ['uploads' as const]};
  assert.equal(impactBrief(confirmed, 'are you not able to read the file?'), REQUEST);
  assert.equal(impactBrief(confirmed, 'Summarise the mapping sheet for me'), 'Summarise the mapping sheet for me');
});

// --- carried file references -----------------------------------------------------------
const user = (id: string, role: string) => ({ id, role } as any);
const asset = (id: string, ownerUserId: string | null) => ({ id, filename: `${id}.sql`, session: { ownerUserId } });
const found = [asset('a-alice', 'alice'), asset('b-bob', 'bob'), asset('c-legacy', null)];
const ids = carriedAssetIds([[{ assetId: 'a-alice' }, { assetId: 'b-bob' }], [{ assetId: 'c-legacy' }, { assetId: 'gone' }]]);
const carriedFor = (actor: any) => accessibleCarried(ids, found, source => canAccessSession(actor, source)).map(a => a.id);

test('an admin continuing another user\'s chat keeps every carried file', () => {
  assert.deepEqual(carriedFor(user('root', 'admin')), ['a-alice', 'b-bob', 'c-legacy']);
});

test('owners keep only files from chats they can open; others and auditors get none', () => {
  assert.deepEqual(carriedFor(user('alice', 'analyst')), ['a-alice']);
  assert.deepEqual(carriedFor(user('mallory', 'analyst')), []);
  assert.deepEqual(carriedFor(user('audit', 'auditor')), []);
});

test('carried order follows the reference order and missing assets are dropped', () => {
  const reversed = accessibleCarried(['c-legacy', 'missing', 'a-alice'], found, () => true).map(a => a.id);
  assert.deepEqual(reversed, ['c-legacy', 'a-alice']);
  assert.deepEqual(accessibleCarried(['x'], [{ id: 'x', session: null }], () => true), []);
});
