/**
 * Builds the fixture snapshot zip used by e2e/backup-restore.spec.ts's
 * fresh-install upload test.
 *
 * Spins up a throwaway data dir (fresh app.db + one project + one file +
 * mail.key), takes a real snapshot into a throwaway LocalStore, and streams
 * it to e2e/fixtures/assets/snapshot-fixture.zip via the same
 * takeSnapshot/streamSnapshotZip code paths the app itself uses — so the
 * fixture is byte-for-byte what a real backup produces, not a hand-rolled zip.
 *
 * IMPORTANT: re-run this (`npx tsx scripts/build-e2e-snapshot.ts`) whenever a
 * migration changes the schema this fixture carries. Restoring only refuses a
 * snapshot whose schemaVersion is NEWER than the server's, so an older
 * fixture keeps working after new migrations land — it is only broken by a
 * migration that changes something the fixture's own setup depends on (e.g.
 * the shape of the `projects` or `files` insert below).
 *
 * Usage:
 *   npx tsx scripts/build-e2e-snapshot.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { openDb } from '../server/db';
import { runMigrations } from '../server/migrations';
import { migrations } from '../server/migrationList';
import { createProject } from '../server/projectStore';
import { putBuffer } from '../server/files';
import { loadMailCrypto } from '../server/mail/crypto';
import { takeSnapshot } from '../server/backup/snapshot';
import { LocalStore } from '../server/backup/store';
import { streamSnapshotZip } from '../server/backup/zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'assets', 'snapshot-fixture.zip');

function readAppVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return pkg.version as string;
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-e2e-snapshot-data-'));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-e2e-snapshot-store-'));
  const db = openDb(path.join(dataDir, 'app.db'));
  try {
    runMigrations(db, dataDir, migrations);

    // One project, so a restored server has something to open.
    createProject(db, {
      id: 'e2e-restored',
      name: 'E2E Restored Project',
      createdAt: Date.now(),
      pages: [],
      takeoffs: [],
    });

    // One files row (a small text blob), so the snapshot carries an object.
    const fileId = uuidv4();
    putBuffer(db, dataDir, fileId, Buffer.from('e2e fixture file contents\n'.repeat(40), 'utf8'), 'text/plain', {
      projectId: 'e2e-restored',
      kind: 'document',
      name: 'restored-note.txt',
    });

    // mail.key — generated exactly the way a real fresh server would.
    loadMailCrypto(dataDir, {});

    const store = new LocalStore(storeDir);
    const { snapshotId } = await takeSnapshot(db, dataDir, store, {
      trigger: 'manual',
      keep: 10,
      appVersion: readAppVersion(),
      env: {},
    });

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const out = fs.createWriteStream(OUT);
    await streamSnapshotZip(store, snapshotId, out);

    console.log(`Wrote ${OUT} (snapshot ${snapshotId})`);
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
