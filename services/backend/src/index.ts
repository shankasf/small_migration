// OTEL must load first so auto-instrumentation can patch http/express/pg
import './otel.js';

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { installRealtime, emitAuthorized } from './services/realtime.js';
import { PolicyError } from './services/aiService.js';
import { recordAudit } from './services/audit.js';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import sessionsRouter from './routes/sessions.js';
import chatRouter from './routes/chat.js';
import filesRouter from './routes/files.js';
import fileLibraryRouter from './routes/fileLibrary.js';
import { startFileIndexer } from './services/fileLibrary.js';
import sttRouter from './routes/stt.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import apiKeysRouter from './routes/apiKeys.js';
import { integrationsRouter, integrationCallbackRouter } from './routes/integrations.js';
import { githubRouter, githubCallbackRouter, githubWebhookRouter } from './routes/github.js';
import { authenticate, requireInternalKey, seedAdminUser } from './middleware/auth.js';
import {
  AiLogEvent, buildAiLogRecord, isPersistable, persistAiLog,
} from './services/aiLog.js';

dotenv.config();

// Fail fast on missing security config — never serve with auth half-configured
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
}
if (!process.env.INTERNAL_API_KEY) {
  throw new Error('INTERNAL_API_KEY must be set (shared secret for the AI service)');
}

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  path: '/api/socket.io',
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

// Production traffic reaches Express through exactly one internet-facing ALB.
// Trust that single hop so req.ip resolves the client address appended by the
// ALB instead of recording the local/proxy socket address in every audit row.
// Limiting this to one hop prevents a client-supplied left-most XFF value from
// being accepted as the caller address.
app.set('trust proxy', 1);

// Make io available globally for broadcasting logs
export { io };

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.locals.prisma = prisma;
app.use('/api/integrations', githubWebhookRouter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Make prisma available to routes
app.locals.prisma = prisma;
app.locals.io = io;
app.locals.recordAiEvent = recordAiEvent;

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[REQ] ${req.method} ${req.path} content-type=${req.headers['content-type'] || 'none'} content-length=${req.headers['content-length'] || 'none'}`);
  res.on('finish', () => {
    console.log(`[RES] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Service-to-service endpoints are registered BEFORE the user-auth middleware
// and carry their own fail-closed x-internal-key guard. Registering them here
// (rather than exempting a path prefix inside authenticate) means a new route
// can never inherit an auth exemption implicitly.
app.post('/api/logs/:sessionId', requireInternalKey, (req, res) => {
  const { sessionId } = req.params;
  const {
    step, message, type, data, turn_id, tool, provider, model,
    input_tokens, output_tokens, duration_ms, detail,
  } = req.body || {};

  // Streamed token deltas stay on the fast path: they are chat content for one
  // session, never an activity record, and must not touch the database.
  if (type === 'delta') {
    void emitAuthorized(io, prisma, `session:${sessionId}`, 'log', { timestamp: new Date().toISOString(), step, message, type, data });
    return res.json({ ok: true });
  }

  recordAiEvent({
    sessionId,
    turnId: turn_id ?? null,
    step,
    message,
    type,
    tool: tool ?? null,
    provider: provider ?? null,
    model: model ?? null,
    inputTokens: input_tokens ?? 0,
    outputTokens: output_tokens ?? 0,
    durationMs: duration_ms ?? null,
    detail: detail ?? data ?? null,
  });
  res.json({ ok: true });
});

// OAuth providers redirect here without the SPA bearer token. The callback is
// protected by a short-lived, single-use state value created on an authenticated
// request; no other integration route is public.
app.use('/api/integrations', githubCallbackRouter);
app.use('/api/integrations', integrationCallbackRouter);

// Authentication — every route below this line requires a valid user token
app.use(authenticate(prisma));
// A durable intent event must succeed before any authenticated mutation.
app.use(async (req: import('./middleware/auth.js').AuthedRequest, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  try {
    await recordAudit(prisma, {userId: req.user?.id, action: 'request.mutation', resource: req.path,
      detail: req.apiKeyId ? JSON.stringify({type: 'api_key'}) : null});
    next();
  } catch { res.status(503).json({error: 'Audit service unavailable. No change was started.'}); }
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/files/library', fileLibraryRouter);
app.use('/api/files', filesRouter);
app.use('/api/stt', sttRouter);
app.use('/api/integrations', githubRouter);
app.use('/api/integrations', integrationsRouter);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof PolicyError) {
    const user = (req as import('./middleware/auth.js').AuthedRequest).user;
    void recordAudit(prisma, { userId: user?.id, action: 'guardrail.block', decision: 'blocked', severity: 'critical',
      detail: JSON.stringify(err.result.guardrail) }).catch(() => console.error("[AUDIT_FAILED] Block event could not be persisted"));
    return res.status(422).json({ error: err.result.error || 'Content blocked by policy', guardrail: err.result.guardrail });
  }
  const status = (err as Error & { statusCode?: number }).statusCode;
  if (status === 400 || status === 403 || status === 409) return res.status(status).json({ error: err.message });
  console.error('[REQUEST_FAILED]', err.name);
  res.status(503).json({ error: 'Request could not be completed safely. Please try again.' });
});

installRealtime(io, prisma);

/**
 * Record one AI activity event: resolve the acting user and cost, mirror it to
 * the session's own log stream, broadcast it to admin viewers (who can then
 * filter by user id), and persist it.
 */
export function recordAiEvent(event: AiLogEvent) {
  buildAiLogRecord(prisma, event)
    .then(record => {
      void emitAuthorized(io, prisma, `session:${record.sessionId}`, 'log', {
        timestamp: record.timestamp,
        step: record.step,
        message: record.message,
        type: record.type,
      });
      if (!isPersistable(record)) {
        void emitAuthorized(io, prisma, 'admin:logs', 'admin-log', record);
        return;
      }
      void emitAuthorized(io, prisma, 'admin:logs', 'admin-log', record);
      return persistAiLog(prisma, record);
    })
    .catch(err => console.error('[AI-LOG] Failed to record event:', err?.message || err));
}

/** Back-compat helper for callers that only emit session progress messages. */
export function emitLog(sessionId: string, log: { step: string; message: string; type?: string; data?: any }) {
  recordAiEvent({ sessionId, step: log.step, message: log.message, type: log.type, detail: log.data });
}

const stopFileIndexer = startFileIndexer(prisma);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  stopFileIndexer();
  await prisma.$disconnect();
  io.close();
  process.exit(0);
});

httpServer.listen(PORT, async () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
  console.log(`[AUTH] Mode: ${process.env.AUTH_MODE || 'local'}`);
  try {
    await seedAdminUser(prisma);
  } catch (err) {
    console.error('[AUTH] Failed to seed admin user:', err);
  }
  try { await recordAudit(prisma, {action: 'security.configuration', detail: JSON.stringify({policyVersion: '2026-09-08.1'})}); }
  catch { console.error('[AUDIT_FAILED] Startup audit verification failed'); }
});

export { prisma };
