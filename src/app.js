import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { openDb } from './db.js';
import { Storage } from './storage.js';
import { S3Storage } from './storage-s3.js';
import { restoreDb, startDbSync } from './dbsync.js';
import { createMailer } from './mail.js';
import { transfersRouter, deleteTransfer, httpError } from './routes/transfers.js';
import { downloadRouter } from './routes/download.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function loadSecret(dataDir) {
  const p = path.join(dataDir, 'secret');
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(p, s, { mode: 0o600 });
    return s;
  }
}

export async function createApp(config) {
  let dbSync = null;
  let storage;
  let db;
  if (config.storage === 's3') {
    // The S3 backend needs the db for part tracking and the db may need the bucket for restore.
    const probe = new S3Storage(config, null);
    const restored = config.dbSync ? await restoreDb(probe, config.dbPath) : false;
    db = openDb(config.dbPath);
    probe.db = db;
    storage = probe;
    if (config.dbSync) dbSync = startDbSync({ db, storage, dbPath: config.dbPath, debounceMs: config.dbSyncDebounceMs });
    if (restored) console.log('restored transfer index from bucket');
  } else {
    db = openDb(config.dbPath);
    storage = new Storage(config);
  }
  const mailer = createMailer(config.smtp, config.appName);
  const secret = loadSecret(config.dataDir);
  const publicUrl = (req) => config.baseUrl || `${req.protocol}://${req.get('host')}`;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? true);

  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const transfers = transfersRouter({ db, storage, config, mailer, secret, publicUrl });
  app.use('/api/transfers', express.json({ limit: '2mb' }), transfers);
  app.use('/d', downloadRouter({ db, storage, loadTransfer: transfers.loadTransfer, requireAccess: transfers.requireAccess }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, app: config.appName }));
  app.get('/api/config', (_req, res) => res.json({
    appName: config.appName,
    uploadCodeRequired: !!config.uploadCode,
    emailEnabled: !!mailer,
    defaultExpiryDays: config.defaultExpiryDays,
    maxTransferBytes: config.maxTransferBytes,
    chunkSize: config.chunkSize,
    storage: config.storage,
  }));
  app.get('/api/transfers/:id/qr.svg', async (req, res, next) => {
    try {
      const svg = await QRCode.toString(`${publicUrl(req)}/t/${req.params.id}`, { type: 'svg', margin: 1, width: 200 });
      res.type('image/svg+xml').send(svg);
    } catch (err) {
      next(err);
    }
  });

  app.get('/t/:id', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 't.html')));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

  app.use((req, _res, next) => next(httpError(404, `Not found: ${req.method} ${req.path}`)));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.destroy();
    const body = { error: status >= 500 ? 'Server error, check the logs' : err.message };
    if (err.locked) body.locked = true;
    if (err.missing) body.missing = err.missing;
    if (req.path.startsWith('/api/') || req.path.startsWith('/d/') || req.accepts(['html', 'json']) === 'json') {
      return res.status(status).json(body);
    }
    res.status(status).type('text/plain').send(body.error);
  });

  async function cleanup(now = Date.now()) {
    const removed = [];
    const ids = new Set([
      ...db.expiredIds(now),
      ...db.abandonedIds(now - config.abandonedUploadHours * 3600000),
    ]);
    for (const id of ids) {
      try {
        await deleteTransfer({ db, storage }, id);
        removed.push(id);
      } catch (err) {
        console.error(`cleanup failed for ${id}:`, err.message);
      }
    }
    return removed;
  }

  return {
    app, db, storage, cleanup, dbSync,
    close: async () => { if (dbSync) await dbSync.stop(); db.close(); },
  };
}
