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

dotenv.config();

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

// Routes
app.use('/api/sessions', sessionsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/files', filesRouter);
app.use('/api/stt', sttRouter);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// WebSocket connection handling
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

  socket.on('disconnect', () => {
    console.log(`[WebSocket] Client disconnected: ${socket.id}`);
  });
});

// Helper to emit logs to a session
export function emitLog(sessionId: string, log: { step: string; message: string; type?: string; data?: any }) {
  io.to(`session:${sessionId}`).emit('log', {
    timestamp: new Date().toISOString(),
    ...log
  });
}

// Endpoint for AI service to send logs
app.post('/api/logs/:sessionId', express.json(), (req, res) => {
  const { sessionId } = req.params;
  const { step, message, type, data } = req.body;
  emitLog(sessionId, { step, message, type, data });
  res.json({ ok: true });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await prisma.$disconnect();
  io.close();
  process.exit(0);
});

httpServer.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});

export { prisma };
