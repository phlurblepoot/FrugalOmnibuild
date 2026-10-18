import type Database from 'better-sqlite3';
import type { BroadcastChange } from '../realtime/changeFeed';
import type { MailCrypto } from './crypto';
import type { MailAccountRow, ImapAuth, OAuthAuth } from './accountStore';
import type { MailProvider } from './providers/types';
import type { MailScheduler } from './sync/scheduler';
import type { Notifier } from '../notifications';

export interface MailContext {
  db: Database.Database;
  dataDir: string;
  crypto: MailCrypto;
  providerFactory: (account: MailAccountRow, auth: ImapAuth | OAuthAuth) => MailProvider;
  broadcastChange: BroadcastChange;
  scheduler?: MailScheduler;
  /** The notification bell: tells an RFI's assignee and sender when the GC answers. */
  notifier?: Notifier;
}
