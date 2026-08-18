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
  const { step, message, type, data } = req.body;
  emitLog(sessionId, { step, message, type, data });
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

// Ring buffer of AI-service activity since this process started (i.e. since
// the last deployment) — backfills the admin portal's live log view.
const ADMIN_LOG_BUFFER_MAX = 1000;
const adminLogBuffer: Array<{ sessionId: string; timestamp: string; step: string; message: string; type?: string }> = [];
app.locals.adminLogBuffer = adminLogBuffer;

// Helper to emit logs to a session (and mirror to the admin stream)
export function emitLog(sessionId: string, log: { step: string; message: string; type?: string; data?: any }) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...log
  };
  io.to(`session:${sessionId}`).emit('log', entry);
  // Streamed token deltas are chat content, not operational activity — keep
  // them out of the admin stream and its backfill buffer.
  if (log.type !== 'delta') {
    const adminEntry = { sessionId, timestamp: entry.timestamp, step: log.step, message: log.message, type: log.type };
    adminLogBuffer.push(adminEntry);
    if (adminLogBuffer.length > ADMIN_LOG_BUFFER_MAX) adminLogBuffer.shift();
    io.to('admin:logs').emit('admin-log', adminEntry);
  }
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
});

export { prisma };
