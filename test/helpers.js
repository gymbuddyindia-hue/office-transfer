import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

export async function startServer(envOverrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-transfer-test-'));
  const env = { DATA_DIR: dataDir, CHUNK_SIZE_MB: '1', ...envOverrides };
  const config = loadConfig({ ...process.env, SMTP_HOST: '', ...env });
  // chunk size override in bytes for small test chunks
  if (env.CHUNK_BYTES) config.chunkSize = Number(env.CHUNK_BYTES);
  const inst = await createApp(config);
  const server = await new Promise((resolve) => {
    const s = inst.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    config,
    ...inst,
    async stop() {
      await new Promise((r) => server.close(r));
      await inst.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function api(base, method, url, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) {
    init.body = raw;
    init.headers['content-type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

export function randomBytes(n, seed = 7) {
  const buf = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf[i] = x & 0xff; }
  return buf;
}

/** Upload a whole file through the chunk API. */
export async function uploadFile(base, transfer, file, data, headers) {
  const cs = transfer.chunkSize;
  for (let n = 0; n < file.chunksTotal; n++) {
    const chunk = data.subarray(n * cs, Math.min(data.length, (n + 1) * cs));
    const r = await api(base, 'PUT', `/api/transfers/${transfer.id}/files/${file.id}/chunks/${n}`, { raw: chunk, headers });
    if (r.status !== 200) throw new Error(`chunk ${n} failed: ${r.status} ${r.text}`);
  }
}

/** POST /complete then poll until the server reports ready. Returns the final info. */
export async function completeAndWait(base, transfer, headers) {
  const first = await api(base, 'POST', `/api/transfers/${transfer.id}/complete`, { headers });
  if (first.status !== 202 && first.status !== 200) return first;
  for (let i = 0; i < 200; i++) {
    const info = await api(base, 'GET', `/api/transfers/${transfer.id}`, { headers });
    if (info.json.finishError) return { status: 500, json: { error: info.json.finishError }, text: info.json.finishError };
    if (info.json.status === 'ready') return { status: 200, json: { ...first.json, ...info.json }, text: info.text };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('transfer never became ready');
}
