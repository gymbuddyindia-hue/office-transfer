import { Router } from 'express';
import { newId, newToken, hashPassword, verifyPassword, makeAccessToken, verifyAccessToken, sanitiseName } from '../ids.js';

const EXPIRY_DAYS = new Set([0, 1, 3, 7, 14, 30, 90]);
const MAX_FILES = 5000;

export function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

export function transfersRouter({ db, storage, config, mailer, secret, publicUrl }) {
  const r = Router();

  const requireUploadCode = (req, _res, next) => {
    if (!config.uploadCode) return next();
    const given = req.get('x-upload-code') ?? '';
    if (given !== config.uploadCode) return next(httpError(401, 'Upload code is wrong or missing'));
    next();
  };

  const loadTransfer = (req, _res, next) => {
    const t = db.getTransfer(req.params.id);
    if (!t) return next(httpError(404, 'This transfer does not exist or has been deleted'));
    if (t.expires_at && t.expires_at <= Date.now()) return next(httpError(410, 'This transfer has expired'));
    req.transfer = t;
    next();
  };

  const requireOwner = (req, _res, next) => {
    const token = req.get('x-owner-token') ?? '';
    if (token !== req.transfer.owner_token) return next(httpError(403, 'Owner token is wrong or missing'));
    next();
  };

  /** Password-protected transfers need a valid access token (from /unlock) or the owner token. */
  const requireAccess = (req, _res, next) => {
    const t = req.transfer;
    if (!t.password_hash) return next();
    if ((req.get('x-owner-token') ?? '') === t.owner_token) return next();
    const token = req.get('x-access-token') ?? req.query.token;
    if (verifyAccessToken(secret, t.id, token)) return next();
    next(httpError(401, 'Password required', { locked: true }));
  };

  r.post('/', requireUploadCode, (req, res, next) => {
    try {
      const body = req.body ?? {};
      const files = Array.isArray(body.files) ? body.files : [];
      if (files.length === 0) throw httpError(400, 'Add at least one file');
      if (files.length > MAX_FILES) throw httpError(400, `At most ${MAX_FILES} files per transfer`);

      const expiresInDays = body.expiresInDays === undefined ? config.defaultExpiryDays : Number(body.expiresInDays);
      if (!EXPIRY_DAYS.has(expiresInDays)) throw httpError(400, 'expiresInDays must be one of 0, 1, 3, 7, 14, 30, 90');
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length > 200) throw httpError(400, 'Password too long');
      const recipients = Array.isArray(body.recipients)
        ? body.recipients.map((e) => String(e).trim()).filter(Boolean).slice(0, 50)
        : [];
      for (const e of recipients) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, `"${e}" is not a valid email address`);
      }

      const now = Date.now();
      const chunkSize = config.chunkSize;
      let totalBytes = 0;
      const fileRows = files.map((f) => {
        const size = Number(f.size);
        if (!Number.isInteger(size) || size < 0) throw httpError(400, `Bad size for file "${f.name}"`);
        totalBytes += size;
        return {
          id: newId(),
          name: sanitiseName(f.name),
          size,
          chunkSize,
          chunksTotal: Math.max(1, Math.ceil(size / chunkSize)),
        };
      });
      if (config.maxTransferBytes && totalBytes > config.maxTransferBytes) {
        throw httpError(413, `Transfer is larger than the configured limit of ${config.maxTransferBytes} bytes`);
      }

      const transfer = {
        id: newId(),
        title: String(body.title ?? '').slice(0, 200),
        message: String(body.message ?? '').slice(0, 5000),
        senderEmail: String(body.senderEmail ?? '').trim().slice(0, 200),
        recipients,
        expiresAt: expiresInDays === 0 ? null : now + expiresInDays * 86400000,
        passwordHash: password ? hashPassword(password) : null,
        ownerToken: newToken(),
        createdAt: now,
        totalBytes,
      };

      storage.freeBytes().then((free) => {
        if (free !== null && free < totalBytes) {
          return next(httpError(507, `Not enough disk space on the server: ${free} bytes free, ${totalBytes} needed`));
        }
        db.createTransfer(transfer, fileRows);
        res.status(201).json({
          id: transfer.id,
          ownerToken: transfer.ownerToken,
          link: `${publicUrl(req)}/t/${transfer.id}`,
          chunkSize,
          expiresAt: transfer.expiresAt,
          files: fileRows.map((f) => ({ id: f.id, name: f.name, size: f.size, chunksTotal: f.chunksTotal })),
        });
      }).catch(next);
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id/files/:fid/status', loadTransfer, requireOwner, async (req, res, next) => {
    try {
      const f = db.getFile(req.params.fid, req.transfer.id);
      if (!f) throw httpError(404, 'File not found in this transfer');
      const have = await storage.chunkStatus(f.id);
      const done = [];
      for (let i = 0; i < f.chunks_total; i++) {
        const expected = i === f.chunks_total - 1 ? f.size - i * f.chunk_size : f.chunk_size;
        if (have.get(i) === expected) done.push(i);
      }
      res.json({ fileId: f.id, chunksTotal: f.chunks_total, chunksDone: done, assembled: !!f.assembled });
    } catch (err) {
      next(err);
    }
  });

  r.put('/:id/files/:fid/chunks/:n', loadTransfer, requireOwner, async (req, res, next) => {
    try {
      if (req.transfer.status !== 'uploading') throw httpError(409, 'This transfer is already complete');
      const f = db.getFile(req.params.fid, req.transfer.id);
      if (!f) throw httpError(404, 'File not found in this transfer');
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 0 || n >= f.chunks_total) throw httpError(400, `Chunk index must be 0..${f.chunks_total - 1}`);
      const expected = n === f.chunks_total - 1 ? f.size - n * f.chunk_size : f.chunk_size;
      const declared = Number(req.get('content-length'));
      if (Number.isFinite(declared) && declared !== expected) {
        req.resume();
        throw httpError(400, `Chunk ${n} should be ${expected} bytes, got ${declared}`);
      }
      const written = await storage.writeChunk(f.id, n, req);
      if (written !== expected) {
        await storage.removeChunk(f.id, n);
        throw httpError(400, `Chunk ${n} should be ${expected} bytes, received ${written}`);
      }
      res.json({ ok: true, chunk: n, bytes: written });
    } catch (err) {
      if (err.code === 'ENOSPC') return next(httpError(507, 'The server ran out of disk space'));
      next(err);
    }
  });

  r.post('/:id/complete', loadTransfer, requireOwner, async (req, res, next) => {
    try {
      const t = req.transfer;
      const files = db.getFiles(t.id);
      if (t.status !== 'ready') {
        for (const f of files) {
          if (f.assembled) continue;
          await storage.assemble(f.id, f.chunks_total, f.size);
          db.markAssembled(f.id);
        }
        db.completeTransfer(t.id, Date.now());
      }
      const link = `${publicUrl(req)}/t/${t.id}`;
      let emailed = false;
      let emailError = null;
      const recipients = JSON.parse(t.recipients || '[]');
      if (mailer && recipients.length && t.status !== 'ready') {
        try {
          await mailer.sendTransfer({
            to: recipients, link, title: t.title, message: t.message, senderEmail: t.sender_email,
            files, totalBytes: t.total_bytes, expiresAt: t.expires_at,
          });
          emailed = true;
        } catch (err) {
          emailError = err.message;
        }
      }
      res.json({ id: t.id, link, emailed, emailError, recipients });
    } catch (err) {
      if (err.code === 'MISSING_CHUNKS') return next(httpError(409, err.message, { missing: err.missing }));
      if (err.code === 'SIZE_MISMATCH') return next(httpError(409, err.message));
      next(err);
    }
  });

  r.post('/:id/unlock', loadTransfer, (req, res, next) => {
    const t = req.transfer;
    if (!t.password_hash) return res.json({ token: null });
    if (!verifyPassword(req.body?.password ?? '', t.password_hash)) return next(httpError(401, 'Wrong password'));
    res.json({ token: makeAccessToken(secret, t.id) });
  });

  r.get('/:id', loadTransfer, (req, res, next) => {
    const t = req.transfer;
    const isOwner = (req.get('x-owner-token') ?? '') === t.owner_token;
    const token = req.get('x-access-token') ?? req.query.token;
    const unlocked = !t.password_hash || isOwner || verifyAccessToken(secret, t.id, token);
    if (!unlocked) {
      return res.status(401).json({ error: 'Password required', locked: true, title: t.title, id: t.id });
    }
    if (t.status !== 'ready' && !isOwner) return next(httpError(409, 'This transfer is still uploading'));
    const files = db.getFiles(t.id).map((f) => ({ id: f.id, name: f.name, size: f.size }));
    res.json({
      id: t.id,
      title: t.title,
      message: t.message,
      senderEmail: t.sender_email,
      createdAt: t.created_at,
      expiresAt: t.expires_at,
      totalBytes: t.total_bytes,
      downloadCount: t.download_count,
      status: t.status,
      protected: !!t.password_hash,
      isOwner,
      accessToken: isOwner && t.password_hash ? makeAccessToken(secret, t.id) : undefined,
      recipients: isOwner ? JSON.parse(t.recipients || '[]') : undefined,
      files,
    });
  });

  r.delete('/:id', loadTransfer, requireOwner, async (req, res, next) => {
    try {
      await deleteTransfer({ db, storage }, req.transfer.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  r.requireAccess = requireAccess;
  r.loadTransfer = loadTransfer;
  return r;
}

export async function deleteTransfer({ db, storage }, id) {
  const files = db.getFiles(id);
  for (const f of files) await storage.removeFile(f.id);
  db.deleteTransfer(id);
}
