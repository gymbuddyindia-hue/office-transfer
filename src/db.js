import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  sender_email TEXT NOT NULL DEFAULT '',
  recipients TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER,
  password_hash TEXT,
  owner_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading'
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunks_total INTEGER NOT NULL,
  assembled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_transfer ON files(transfer_id);
CREATE INDEX IF NOT EXISTS transfers_expires ON transfers(expires_at);
CREATE INDEX IF NOT EXISTS transfers_status ON transfers(status, created_at);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const q = {
    insertTransfer: db.prepare(`INSERT INTO transfers
      (id, title, message, sender_email, recipients, expires_at, password_hash, owner_token, created_at, total_bytes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`),
    insertFile: db.prepare(`INSERT INTO files (id, transfer_id, name, size, chunk_size, chunks_total, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getTransfer: db.prepare('SELECT * FROM transfers WHERE id = ?'),
    getFiles: db.prepare('SELECT * FROM files WHERE transfer_id = ? ORDER BY rowid'),
    getFile: db.prepare('SELECT * FROM files WHERE id = ? AND transfer_id = ?'),
    markAssembled: db.prepare('UPDATE files SET assembled = 1 WHERE id = ?'),
    completeTransfer: db.prepare(`UPDATE transfers SET status = 'ready', completed_at = ? WHERE id = ?`),
    bumpDownloads: db.prepare('UPDATE transfers SET download_count = download_count + 1 WHERE id = ?'),
    deleteTransfer: db.prepare('DELETE FROM transfers WHERE id = ?'),
    expired: db.prepare(`SELECT id FROM transfers WHERE expires_at IS NOT NULL AND expires_at <= ?`),
    abandoned: db.prepare(`SELECT id FROM transfers WHERE status = 'uploading' AND created_at <= ?`),
  };

  return {
    raw: db,
    createTransfer(t, files) {
      db.exec('BEGIN');
      try {
        q.insertTransfer.run(t.id, t.title, t.message, t.senderEmail, JSON.stringify(t.recipients),
          t.expiresAt, t.passwordHash, t.ownerToken, t.createdAt, t.totalBytes);
        for (const f of files) {
          q.insertFile.run(f.id, t.id, f.name, f.size, f.chunkSize, f.chunksTotal, t.createdAt);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getTransfer: (id) => q.getTransfer.get(id) ?? null,
    getFiles: (transferId) => q.getFiles.all(transferId),
    getFile: (fileId, transferId) => q.getFile.get(fileId, transferId) ?? null,
    markAssembled: (fileId) => q.markAssembled.run(fileId),
    completeTransfer: (id, when) => q.completeTransfer.run(when, id),
    bumpDownloads: (id) => q.bumpDownloads.run(id),
    deleteTransfer: (id) => q.deleteTransfer.run(id),
    expiredIds: (now) => q.expired.all(now).map((r) => r.id),
    abandonedIds: (before) => q.abandoned.all(before).map((r) => r.id),
    close: () => db.close(),
  };
}
