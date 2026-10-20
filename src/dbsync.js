/* Keeps a copy of the SQLite file in the bucket so a diskless host (Render free,
 * any container without a volume) keeps its transfer metadata across restarts.
 * The files themselves already live in the bucket; this covers the index. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export async function restoreDb(storage, dbPath) {
  if (fs.existsSync(dbPath)) return false;
  try {
    const res = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: storage.key('_meta/transfer.sqlite') }));
    await fsp.mkdir(require_dir(dbPath), { recursive: true });
    await fsp.writeFile(dbPath, await res.Body.transformToByteArray());
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

function require_dir(p) { return p.slice(0, p.lastIndexOf('/')) || '.'; }

export function startDbSync({ db, storage, dbPath, debounceMs = 3000, log = console }) {
  let timer = null;
  let running = null;
  let dirty = false;

  async function upload() {
    const snapshot = `${dbPath}.snapshot`;
    await fsp.rm(snapshot, { force: true });
    db.raw.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    const body = await fsp.readFile(snapshot);
    await storage.client.send(new PutObjectCommand({
      Bucket: storage.bucket, Key: storage.key('_meta/transfer.sqlite'), Body: body, ContentLength: body.length,
    }));
    await fsp.rm(snapshot, { force: true });
  }

  async function flush() {
    if (running) { dirty = true; return running; }
    clearTimeout(timer); timer = null;
    running = upload().catch((err) => log.error('db sync failed:', err.message)).finally(() => {
      running = null;
      if (dirty) { dirty = false; schedule(); }
    });
    return running;
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  }

  const off = db.onChange(schedule);
  return {
    flush,
    stop: async () => { off(); clearTimeout(timer); if (running) await running; if (dirty || timer) await flush(); },
  };
}
