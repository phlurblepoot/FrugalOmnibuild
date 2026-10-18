// server/realtime/verifyPayload.ts
// Boundary normalization for JWT payloads (carried WS1 finding): a legacy or
// malformed token must yield null — never identity fields like the string
// "undefined". WS2+ gates behavior on role, so this is load-bearing.
export function normalizeTokenPayload(raw: unknown): { id: string; username: string; role: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id) return null;
  if (typeof p.username !== 'string' || !p.username) return null;
  if (typeof p.role !== 'string' || !p.role) return null;
  return { id: p.id, username: p.username, role: p.role };
}
