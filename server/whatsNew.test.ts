// server/whatsNew.test.ts: the version each person last saw "What's new" for
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fsSync from 'fs';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { LAST_SEEN_PREF, getLastSeenVersion, registerWhatsNewRoutes, setLastSeenVersion } from './whatsNew';

let db: Database.Database;
const appAs = (id: string) => {
  const a = express();
  a.use(express.json());
  registerWhatsNewRoutes(a, { db, authenticateToken: (req: any, _res: any, next: any) => { req.user = { id, role: 'user' }; next(); } });
  return a;
};

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-wn-')), migrations);
});

describe("What's new: last version seen", () => {
  it('is none at first, then the version saved, for that person only', async () => {
    const nick = appAs('u1'), ana = appAs('u2');
    expect((await request(nick).get('/api/me/whats-new')).body).toEqual({ lastSeenVersion: null });
    expect((await request(nick).put('/api/me/whats-new').send({ lastSeenVersion: '4.7.0' })).status).toBe(200);
    expect((await request(nick).get('/api/me/whats-new')).body).toEqual({ lastSeenVersion: '4.7.0' });
    expect((await request(ana).get('/api/me/whats-new')).body).toEqual({ lastSeenVersion: null });
  });

  it('only takes a version', async () => {
    const res = await request(appAs('u1')).put('/api/me/whats-new').send({ lastSeenVersion: 'latest' });
    expect(res.status).toBe(400);
    expect(getLastSeenVersion(db, 'u1')).toBeNull();
  });

  it('is kept as a user preference (stamped on new accounts by server.ts)', () => {
    setLastSeenVersion(db, 'u3', '4.7.0');
    expect(db.prepare('SELECT value FROM user_preferences WHERE userId = ? AND key = ?').get('u3', LAST_SEEN_PREF)).toEqual({ value: '4.7.0' });
  });
});
