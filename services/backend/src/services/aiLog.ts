import { PrismaClient } from '@prisma/client';
import { computeCostUsd } from './usage.js';

/**
 * AI activity log — the observability spine for agent runs.
 *
 * The AI service posts one event per observable step (guardrail decision,
 * model call, tool call, tool result, final output). Those posts only carry a
 * session id, so identity is resolved *here*, from the turn the backend itself
 * opened before calling the AI service. That keeps user attribution
 * authoritative on the backend rather than trusting whatever the AI service
 * echoes back, and it means every row can be filtered by user id.
 */

export interface TurnContext {
  turnId: string;
  sessionId: string;
  userId: string;
  userEmail: string;
  startedAt: number;
}

const TURN_TTL_MS = 60 * 60 * 1000; // an agent turn can legitimately run for minutes
const turnById = new Map<string, TurnContext>();
const turnBySession = new Map<string, TurnContext>();

function sweepTurns() {
  const cutoff = Date.now() - TURN_TTL_MS;
  for (const [id, ctx] of turnById) {
    if (ctx.startedAt < cutoff) {
      turnById.delete(id);
      if (turnBySession.get(ctx.sessionId)?.turnId === id) turnBySession.delete(ctx.sessionId);
    }
  }
}

/** Open a turn so every log line the AI service emits for it is attributable. */
export function beginTurn(ctx: Omit<TurnContext, 'startedAt'>): TurnContext {
  sweepTurns();
  const full: TurnContext = { ...ctx, startedAt: Date.now() };
  turnById.set(full.turnId, full);
  turnBySession.set(full.sessionId, full);
  return full;
}

/** Late-arriving events (a slow tool result) still resolve until the TTL. */
export function resolveTurn(sessionId?: string, turnId?: string): TurnContext | undefined {
  if (turnId) {
    const byId = turnById.get(turnId);
    if (byId) return byId;
  }
  if (sessionId) return turnBySession.get(sessionId);
  return undefined;
}

// Session owner fallback for events that arrive outside a known turn (e.g. the
// backend restarted mid-run). Bounded so it cannot grow without limit.
const OWNER_CACHE_MAX = 500;
const ownerCache = new Map<string, { userId: string | null; userEmail: string | null }>();

export async function resolveSessionOwner(prisma: PrismaClient, sessionId: string) {
  const cached = ownerCache.get(sessionId);
  if (cached) return cached;
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { ownerUserId: true, owner: { select: { email: true } } },
    });
    const resolved = {
      userId: session?.ownerUserId ?? null,
      userEmail: session?.owner?.email ?? null,
    };
    if (ownerCache.size >= OWNER_CACHE_MAX) ownerCache.delete(ownerCache.keys().next().value as string);
    ownerCache.set(sessionId, resolved);
    return resolved;
  } catch {
    return { userId: null, userEmail: null };
  }
}

export interface AiLogEvent {
  sessionId: string;
  turnId?: string | null;
  step: string;
  message: string;
  type?: string;
  tool?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  /** Cost is derived from the shared pricing table unless supplied explicitly. */
  costUsd?: number;
  durationMs?: number | null;
  detail?: unknown;
}

/** The shape broadcast to admin clients and returned by the history endpoint. */
export interface AiLogRecord {
  id: string;
  sessionId: string;
  turnId: string | null;
  userId: string | null;
  userEmail: string | null;
  timestamp: string;
  step: string;
  type: string;
  message: string;
  tool: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number | null;
  detail: string | null;
}

const DETAIL_MAX_CHARS = 20000;

function serialiseDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (!text) return null;
  return text.length > DETAIL_MAX_CHARS
    ? `${text.slice(0, DETAIL_MAX_CHARS)}\n… [truncated, ${text.length} characters total]`
    : text;
}

/** Build the broadcast/persistence record, resolving identity and cost. */
export async function buildAiLogRecord(
  prisma: PrismaClient,
  event: AiLogEvent
): Promise<AiLogRecord> {
  const turn = resolveTurn(event.sessionId, event.turnId ?? undefined);
  const owner = turn ? null : await resolveSessionOwner(prisma, event.sessionId);

  const inputTokens = Math.max(0, Math.trunc(event.inputTokens || 0));
  const outputTokens = Math.max(0, Math.trunc(event.outputTokens || 0));
  const costUsd = event.costUsd != null
    ? event.costUsd
    : inputTokens || outputTokens
      ? computeCostUsd(event.model || 'unknown', inputTokens, outputTokens)
      : 0;

  return {
    id: cryptoRandomId(),
    sessionId: event.sessionId,
    turnId: event.turnId ?? turn?.turnId ?? null,
    userId: turn?.userId ?? owner?.userId ?? null,
    userEmail: turn?.userEmail ?? owner?.userEmail ?? null,
    timestamp: new Date().toISOString(),
    step: event.step || 'event',
    type: event.type || 'info',
    message: event.message ?? '',
    tool: event.tool ?? null,
    provider: event.provider ?? null,
    model: event.model ?? null,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    durationMs: event.durationMs ?? null,
    detail: serialiseDetail(event.detail),
  };
}

function cryptoRandomId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Transient UI chatter ("thinking…", streamed deltas) is never persisted — it
 * is progress feedback, not an audit record.
 */
const EPHEMERAL_TYPES = new Set(['delta', 'thinking']);

export function isPersistable(record: AiLogRecord): boolean {
  return !EPHEMERAL_TYPES.has(record.type);
}

export async function persistAiLog(prisma: PrismaClient, record: AiLogRecord): Promise<void> {
  if (!isPersistable(record)) return;
  try {
    await prisma.aiActivityLog.create({
      data: {
        id: record.id,
        userId: record.userId,
        sessionId: record.sessionId,
        turnId: record.turnId,
        step: record.step,
        type: record.type,
        message: record.message.slice(0, DETAIL_MAX_CHARS),
        tool: record.tool,
        provider: record.provider,
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalTokens: record.totalTokens,
        costUsd: record.costUsd,
        durationMs: record.durationMs,
        detail: record.detail,
        createdAt: new Date(record.timestamp),
      },
    });
  } catch (err) {
    // Logging must never break a chat turn.
    console.error('[AI-LOG] Failed to persist activity log:', (err as Error)?.message || err);
  }
}

/**
 * Retention: activity logs carry prompt/result previews, so they are pruned on
 * a schedule rather than kept forever. Window is config, not code.
 */
export function startAiLogRetention(prisma: PrismaClient) {
  const days = Math.max(1, parseInt(process.env.AI_LOG_RETENTION_DAYS || '30', 10) || 30);
  const prune = async () => {
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const { count } = await prisma.aiActivityLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
      if (count > 0) console.log(`[AI-LOG] Pruned ${count} activity rows older than ${days}d`);
    } catch (err) {
      console.error('[AI-LOG] Retention sweep failed:', (err as Error)?.message || err);
    }
  };
  // First sweep a minute after boot, then daily.
  const initial = setTimeout(prune, 60_000);
  const daily = setInterval(prune, 24 * 60 * 60 * 1000);
  initial.unref?.();
  daily.unref?.();
}
