import { v4 as uuidv4 } from 'uuid';
// Stable per-tab id for self-echo suppression on the change feed. Deliberately
// NOT the socket sessionId (= socket.id): that changes on every reconnect and
// doesn't exist before the socket connects, while REST calls fire immediately.
export const CLIENT_SESSION_ID = uuidv4();
