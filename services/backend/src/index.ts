// OTEL must load first so auto-instrumentation can patch http/express/pg
import './otel.js';

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import sessionsRouter from './routes/sessions.js';
import chatRouter from './routes/chat.js';
import filesRouter from './routes/files.js';
import sttRouter from './routes/stt.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import { authenticate, requireInternalKey, resolveUserFromToken, seedAdminUser } from './middleware/auth.js';
import {
  AiLogEvent, AiLogRecord, buildAiLogRecord, isPersistable, persistAiLog, startAiLogRetention,
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Make prisma available to routes
app.locals.prisma = prisma;

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[REQ] ${req.method} ${req.url} content-type=${req.headers['content-type'] || 'none'} content-length=${req.headers['content-length'] || 'none'}`);
  res.on('finish', () => {
    console.log(`[RES] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
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
    io.to(`session:${sessionId}`).emit('log', { timestamp: new Date().toISOString(), step, message, type, data });
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

// Authentication — every route below this line requires a valid user token
app.use(authenticate(prisma));

// Routes
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/files', filesRouter);
app.use('/api/stt', sttRouter);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// WebSocket connection handling — clients authenticate with their API token,
// verified per the configured auth mode (local JWT / Entra / OIDC), same as
// HTTP requests. The resolved user rides on socket.data for role checks.
io.use(async (socket, next) => {
  try {
    const token = (socket.handshake.auth as any)?.token as string | undefined;
    if (!token) return next(new Error('Authentication required'));
    const user = await resolveUserFromToken(prisma, token);
    if (!user || user.status === 'disabled') return next(new Error('Invalid token'));
    socket.data.user = { id: user.id, role: user.role };
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`[WebSocket] Client connected: ${socket.id}`);

  // Join session-specific room for targeted logs
  socket.on('join-session', (sessionId: string) => {
    socket.join(`session:${sessionId}`);
    console.log(`[WebSocket] ${socket.id} joined session: ${sessionId}`);
  });

  socket.on('leave-session', (sessionId: string) => {
    socket.leave(`session:${sessionId}`);
    console.log(`[WebSocket] ${socket.id} left session: ${sessionId}`);
  });

  // Global AI-service log stream for the admin portal (admin/auditor only)
  socket.on('join-admin-logs', () => {
    const role = socket.data.user?.role;
    if (role !== 'admin' && role !== 'auditor') return;
    socket.join('admin:logs');
    console.log(`[WebSocket] ${socket.id} joined admin log stream`);
  });

  socket.on('leave-admin-logs', () => {
    socket.leave('admin:logs');
  });

  socket.on('disconnect', () => {
    console.log(`[WebSocket] Client disconnected: ${socket.id}`);
  });
});

// Ring buffer of recent AI activity, kept only so a reconnecting admin client
// renders instantly. The durable history lives in the AiActivityLog table.
const ADMIN_LOG_BUFFER_MAX = 500;
const adminLogBuffer: AiLogRecord[] = [];
app.locals.adminLogBuffer = adminLogBuffer;

/**
 * Record one AI activity event: resolve the acting user and cost, mirror it to
 * the session's own log stream, broadcast it to admin viewers (who can then
 * filter by user id), and persist it.
 */
export function recordAiEvent(event: AiLogEvent) {
  buildAiLogRecord(prisma, event)
    .then(record => {
      io.to(`session:${record.sessionId}`).emit('log', {
        timestamp: record.timestamp,
        step: record.step,
        message: record.message,
        type: record.type,
      });
      if (!isPersistable(record)) {
        io.to('admin:logs').emit('admin-log', record);
        return;
      }
      adminLogBuffer.push(record);
      if (adminLogBuffer.length > ADMIN_LOG_BUFFER_MAX) adminLogBuffer.shift();
      io.to('admin:logs').emit('admin-log', record);
      return persistAiLog(prisma, record);
    })
    .catch(err => console.error('[AI-LOG] Failed to record event:', err?.message || err));
}

/** Back-compat helper for callers that only emit session progress messages. */
export function emitLog(sessionId: string, log: { step: string; message: string; type?: string; data?: any }) {
  recordAiEvent({ sessionId, step: log.step, message: log.message, type: log.type, detail: log.data });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
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
  startAiLogRetention(prisma);
});

export { prisma };
