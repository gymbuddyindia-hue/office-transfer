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
CREATE TABLE IF NOT EXISTS parts (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (file_id, n)
);
CREATE INDEX IF NOT EXISTS transfers_expires ON transfers(expires_at);
CREATE INDEX IF NOT EXISTS transfers_status ON transfers(status, created_at);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Column added for the S3 backend; older databases lack it.
  const cols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
  if (!cols.includes('upload_id')) db.exec('ALTER TABLE files ADD COLUMN upload_id TEXT');
  // A restart mid-assembly leaves rows in 'finishing'; the chunks are still on disk, so let the client finish again.
  db.exec(`UPDATE transfers SET status = 'uploading' WHERE status = 'finishing'`);

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
    setStatus: db.prepare('UPDATE transfers SET status = ? WHERE id = ?'),
    resetFinishing: db.prepare(`UPDATE transfers SET status = 'uploading' WHERE status = 'finishing'`),
    bumpDownloads: db.prepare('UPDATE transfers SET download_count = download_count + 1 WHERE id = ?'),
    deleteTransfer: db.prepare('DELETE FROM transfers WHERE id = ?'),
    expired: db.prepare(`SELECT id FROM transfers WHERE expires_at IS NOT NULL AND expires_at <= ?`),
    abandoned: db.prepare(`SELECT id FROM transfers WHERE status = 'uploading' AND created_at <= ?`),
    setUploadId: db.prepare('UPDATE files SET upload_id = ? WHERE id = ?'),
    upsertPart: db.prepare('INSERT OR REPLACE INTO parts (file_id, n, etag, size) VALUES (?, ?, ?, ?)'),
    getParts: db.prepare('SELECT n, etag, size FROM parts WHERE file_id = ? ORDER BY n'),
    deleteParts: db.prepare('DELETE FROM parts WHERE file_id = ?'),
    getFileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  };

  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); };
  const mut = (fn) => (...args) => { const r = fn(...args); changed(); return r; };

  return {
    raw: db,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    createTransfer(t, files) {
      db.exec('BEGIN');
      try {
        q.insertTransfer.run(t.id, t.title, t.message, t.senderEmail, JSON.stringify(t.recipients),
          t.expiresAt, t.passwordHash, t.ownerToken, t.createdAt, t.totalBytes);
        for (const f of files) {
          q.insertFile.run(f.id, t.id, f.name, f.size, f.chunkSize, f.chunksTotal, t.createdAt);
        }
        db.exec('COMMIT');
        changed();
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getTransfer: (id) => q.getTransfer.get(id) ?? null,
    getFiles: (transferId) => q.getFiles.all(transferId),
    getFile: (fileId, transferId) => q.getFile.get(fileId, transferId) ?? null,
    markAssembled: mut((fileId) => q.markAssembled.run(fileId)),
    completeTransfer: mut((id, when) => q.completeTransfer.run(when, id)),
    setStatus: mut((id, status) => q.setStatus.run(status, id)),
    resetFinishing: () => q.resetFinishing.run(),
    bumpDownloads: mut((id) => q.bumpDownloads.run(id)),
    deleteTransfer: mut((id) => q.deleteTransfer.run(id)),
    expiredIds: (now) => q.expired.all(now).map((r) => r.id),
    abandonedIds: (before) => q.abandoned.all(before).map((r) => r.id),
    setUploadId: mut((fileId, uploadId) => q.setUploadId.run(uploadId, fileId)),
    upsertPart: mut((fileId, n, etag, size) => q.upsertPart.run(fileId, n, etag, size)),
    getParts: (fileId) => q.getParts.all(fileId),
    deleteParts: mut((fileId) => q.deleteParts.run(fileId)),
    getFileById: (fileId) => q.getFileById.get(fileId) ?? null,
    close: () => db.close(),
  };
}
