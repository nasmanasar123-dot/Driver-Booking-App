import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { Role } from './users.ts';

export interface Realtime {
  toUser(userId: number, event: string, data: unknown): void;
  toAdmins(event: string, data: unknown): void;
  close(): Promise<void>;
}

// Server -> client push only. Clients send everything else over HTTP.
export function attachRealtime(
  httpServer: HttpServer,
  verifyToken: (token: string) => { sub: number; role: Role },
): Realtime {
  const io = new Server(httpServer, { serveClient: false });

  io.use((socket, next) => {
    try {
      socket.data.user = verifyToken(String(socket.handshake.auth?.token ?? ''));
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as { sub: number; role: Role };
    socket.join(`user:${user.sub}`);
    if (user.role === 'admin') socket.join('admins');
  });

  return {
    toUser: (userId, event, data) => io.to(`user:${userId}`).emit(event, data),
    toAdmins: (event, data) => io.to('admins').emit(event, data),
    close: async () => {
      io.disconnectSockets(true);
      io.engine.close();
    },
  };
}
