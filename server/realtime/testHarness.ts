// server/realtime/testHarness.ts
// Test-only helper: real socket.io server + clients on an ephemeral port.
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { registerRealtime, type RealtimeOptions, type RealtimeHandle } from './registerRealtime';

export const TEST_SECRET = 'test-secret';

export function makeToken(payload: Record<string, unknown> = {}): string {
  return jwt.sign({ id: 'u1', username: 'noah', role: 'admin', ...payload }, TEST_SECRET, { expiresIn: '1h' });
}

export function verifyTestToken(token: string) {
  try { return jwt.verify(token, TEST_SECRET) as { id: string; username: string; role: string }; }
  catch { return null; }
}

export async function startRealtimeServer(opts: Partial<RealtimeOptions> = {}) {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const handle: RealtimeHandle = registerRealtime(io, { verifyToken: verifyTestToken, ...opts });
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, () => resolve((httpServer.address() as { port: number }).port));
  });
  return {
    port, io, handle,
    close: async () => {
      handle.dispose();
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export function connectClient(port: number, token: string | undefined, extraAuth: Record<string, unknown> = {}): Socket {
  return ioc(`http://localhost:${port}`, {
    auth: { token, ...extraAuth },
    transports: ['websocket'],
    reconnection: false,
  });
}

export function waitFor<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

export function waitForConnectError(socket: Socket): Promise<Error> {
  return new Promise((resolve) => socket.once('connect_error', resolve));
}

export function emitWithAck<T = any>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
