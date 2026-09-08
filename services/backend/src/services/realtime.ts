import { Server, Socket } from 'socket.io';
import { PrismaClient, User } from '@prisma/client';
import { canAccessSession, resolveUserFromToken } from '../middleware/auth.js';
import { recordAudit } from './audit.js';

export async function socketUser(prisma: PrismaClient, socket: Socket): Promise<User | null> {
  try {
    const token = socket.handshake.auth?.token;
    const user = typeof token === 'string' ? await resolveUserFromToken(prisma, token) : null;
    if (!user || user.status === 'disabled') { socket.disconnect(true); return null; }
    return user;
  } catch { socket.disconnect(true); return null; }
}

export async function canSubscribe(prisma: PrismaClient, user: User, room: string): Promise<boolean> {
  if (user.status === 'disabled') return false;
  if (room === 'admin:logs') return user.role === 'admin' || user.role === 'auditor';
  if (!/^session:[A-Za-z0-9_-]{1,64}$/.test(room)) return false;
  const session = await prisma.session.findUnique({ where: { id: room.slice(8) } });
  return !!session && canAccessSession(user, session);
}

export function installRealtime(io: Server, prisma: PrismaClient) {
  io.use(async (socket, next) => {
    const user = await socketUser(prisma, socket);
    if (!user) return next(new Error('Authentication required'));
    socket.data.user = { id: user.id, role: user.role };
    next();
  });
  io.on('connection', socket => {
    socket.join(`user:${socket.data.user.id}`);
    const join = async (room: string, ack?: (result: {ok: boolean}) => void) => {
      try {
        const user = await socketUser(prisma, socket);
        const allowed = !!user && await canSubscribe(prisma, user, room);
        if (allowed) await socket.join(room);
        else await recordAudit(prisma, {userId: user?.id, action: 'authz.socket_denied', decision: 'deny', severity: 'warning'});
        if (typeof ack === 'function') ack({ok: allowed});
      } catch { socket.disconnect(true); }
    };
    socket.on('join-session', (id: unknown, ack) => {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
      void join(`session:${id}`, ack);
    });
    socket.on('leave-session', (id: unknown) => { if (typeof id === 'string') socket.leave(`session:${id}`); });
    socket.on('join-admin-logs', (ack) => { void join('admin:logs', ack); });
    socket.on('leave-admin-logs', () => { socket.leave('admin:logs'); });
    const timer = setInterval(() => { void socketUser(prisma, socket); }, 15000);
    timer.unref();
    socket.on('disconnect', () => clearInterval(timer));
  });
}

/** Check the token, account and ownership again immediately before delivery. */
export async function emitAuthorized(io: Server, prisma: PrismaClient, room: string, event: string, payload: unknown) {
  const ids = io.sockets.adapter.rooms.get(room);
  for (const id of ids || []) {
    const socket = io.sockets.sockets.get(id);
    if (!socket) continue;
    const user = await socketUser(prisma, socket);
    try {
      if (user && await canSubscribe(prisma, user, room)) socket.emit(event, payload);
      else await socket.leave(room);
    } catch { socket.disconnect(true); }
  }
}
