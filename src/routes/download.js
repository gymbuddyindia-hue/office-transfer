import { Router } from 'express';
import { ZipArchive } from 'archiver';
import { httpError } from './transfers.js';

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function downloadRouter({ db, storage, loadTransfer, requireAccess }) {
  const r = Router();

  const requireReady = (req, _res, next) => {
    if (req.transfer.status !== 'ready') return next(httpError(409, 'This transfer is still uploading'));
    next();
  };

  r.get('/:id/all', loadTransfer, requireAccess, requireReady, async (req, res, next) => {
    const t = req.transfer;
    const files = db.getFiles(t.id);
    const zipName = `${(t.title || 'transfer').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(zipName));
    res.setHeader('Cache-Control', 'no-store');
    const zip = new ZipArchive({ zlib: { level: 0 }, store: true });
    zip.on('error', (err) => next(err));
    zip.on('warning', (err) => console.warn('zip warning', err.message));
    req.on('close', () => zip.abort());
    zip.pipe(res);
    const seen = new Set();
    try {
      for (const f of files) {
        let name = f.name;
        let i = 1;
        while (seen.has(name)) name = f.name.replace(/(\.[^./]*)?$/, ` (${i++})$1`);
        seen.add(name);
        // Entries are appended one at a time so only one object stream is open per zip.
        const body = await storage.readStream(f.id);
        zip.append(body, { name, date: new Date(f.created_at), store: true });
      }
      db.bumpDownloads(t.id);
      zip.finalize();
    } catch (err) {
      zip.abort();
      next(err);
    }
  });

  r.get('/:id/:fid', loadTransfer, requireAccess, requireReady, async (req, res, next) => {
    const f = db.getFile(req.params.fid, req.transfer.id);
    if (!f) return next(httpError(404, 'File not found in this transfer'));
    const baseName = f.name.split('/').pop();
    if (!req.get('range')) db.bumpDownloads(req.transfer.id);
    let url;
    try { url = await storage.downloadUrl(f.id, baseName); } catch (err) { return next(err); }
    if (url) return res.redirect(302, url);
    res.sendFile(storage.finalPath(f.id), {
      dotfiles: 'allow',
      acceptRanges: true,
      cacheControl: false,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(baseName),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }, (err) => {
      if (err && !res.headersSent) next(err.code === 'ENOENT' ? httpError(404, 'File is missing on disk') : err);
    });
  });

  return r;
}
