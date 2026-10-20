/* Same flow as the API test, but with STORAGE=s3 against a local S3-compatible mock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, api, randomBytes, uploadFile, completeAndWait } from './helpers.js';

const require = createRequire(import.meta.url);
const S3rver = require('s3rver');
const CHUNK = 64 * 1024;

async function startMock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3rver-'));
  const mock = new S3rver({
    address: '127.0.0.1', port: 0, silent: true, directory: dir,
    configureBuckets: [{ name: 'transfers' }],
  });
  const { port } = await mock.run();
  return {
    env: {
      STORAGE: 's3', S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_BUCKET: 'transfers', S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'S3RVER', S3_SECRET_ACCESS_KEY: 'S3RVER', S3_FORCE_PATH_STYLE: 'true', S3_PREFIX: 'office',
    },
    dir,
    objects: () => {
      const p = path.join(dir, 'transfers', 'office');
      return fs.existsSync(p) ? fs.readdirSync(p).filter((n) => n.endsWith('._S3rver_object')) : [];
    },
    async stop() { await new Promise((r) => mock.close(r)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('s3 backend: multipart upload, resume status, complete, redirect download, zip, delete', async (t) => {
  const mock = await startMock();
  t.after(() => mock.stop());
  const s = await startServer({ CHUNK_BYTES: String(CHUNK), ...mock.env });
  t.after(() => s.stop());
  assert.equal((await api(s.base, 'GET', '/api/config')).json.storage, 's3');

  const big = randomBytes(CHUNK * 2 + 321, 21);
  const small = randomBytes(10, 22);
  const created = await api(s.base, 'POST', '/api/transfers', {
    body: { title: 'S3 test', files: [{ name: 'big.bin', size: big.length }, { name: 'docs/small.txt', size: small.length }, { name: 'empty.txt', size: 0 }] },
  });
  assert.equal(created.status, 201, created.text);
  const tr = created.json;
  const owner = { 'x-owner-token': tr.ownerToken };
  assert.equal(tr.files[0].chunkSize, CHUNK);
  assert.equal(tr.files[0].chunksTotal, 3);
  assert.ok(s.db.getFileById(tr.files[0].id).upload_id, 'multipart upload was started');
  assert.equal(s.db.getFileById(tr.files[2].id).upload_id, null, 'empty file needs no multipart upload');

  const f0 = tr.files[0];
  const put = (n, buf) => api(s.base, 'PUT', `/api/transfers/${tr.id}/files/${f0.id}/chunks/${n}`, { raw: buf, headers: owner });
  assert.equal((await put(2, big.subarray(2 * CHUNK))).status, 200);
  assert.equal((await put(0, big.subarray(0, CHUNK))).status, 200);
  let st = await api(s.base, 'GET', `/api/transfers/${tr.id}/files/${f0.id}/status`, { headers: owner });
  assert.deepEqual(st.json.chunksDone, [0, 2]);
  assert.equal((await put(1, big.subarray(CHUNK, CHUNK + 3))).status, 400, 'wrong size rejected');
  const incomplete = await api(s.base, 'POST', `/api/transfers/${tr.id}/complete`, { headers: owner });
  assert.equal(incomplete.status, 409);
  assert.deepEqual(incomplete.json.missing, [1]);
  assert.equal((await put(1, big.subarray(CHUNK, 2 * CHUNK))).status, 200);
  // Re-sending a chunk is harmless.
  assert.equal((await put(1, big.subarray(CHUNK, 2 * CHUNK))).status, 200);
  await uploadFile(s.base, tr, tr.files[1], small, owner);
  await uploadFile(s.base, tr, tr.files[2], Buffer.alloc(0), owner);

  const done = await completeAndWait(s.base, tr, owner);
  assert.equal(done.status, 200, done.text);
  assert.equal(s.db.getParts(f0.id).length, 0, 'part records cleaned after completion');
  assert.equal(mock.objects().length, 3);

  // Single download redirects to a presigned URL that serves the exact bytes.
  const red = await fetch(`${s.base}/d/${tr.id}/${f0.id}`, { redirect: 'manual' });
  assert.equal(red.status, 302);
  const loc = red.headers.get('location');
  assert.match(loc, /X-Amz-Signature=/);
  assert.match(loc, /response-content-disposition=/);
  const direct = await fetch(loc);
  assert.equal(direct.status, 200);
  assert.ok(Buffer.from(await direct.arrayBuffer()).equals(big));
  const emptyRed = await fetch(`${s.base}/d/${tr.id}/${tr.files[2].id}`, { redirect: 'manual' });
  assert.equal(emptyRed.status, 302);
  assert.equal((await fetch(emptyRed.headers.get('location'))).headers.get('content-length'), '0');

  // Zip streams through the server from the bucket.
  const zip = await fetch(`${s.base}/d/${tr.id}/all`);
  assert.equal(zip.status, 200);
  const zipBuf = Buffer.from(await zip.arrayBuffer());
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50);
  assert.ok(zipBuf.includes(Buffer.from('docs/small.txt')));
  assert.ok(zipBuf.includes(big.subarray(0, 4096)), 'zip contains stored file bytes');
  assert.equal((await api(s.base, 'GET', `/api/transfers/${tr.id}`)).json.downloadCount, 3);

  assert.equal((await api(s.base, 'DELETE', `/api/transfers/${tr.id}`, { headers: owner })).status, 200);
  assert.equal(mock.objects().length, 0, 'objects removed from bucket');
  assert.equal((await fetch(loc)).status, 404);
});

test('s3 backend: abandoned upload cleanup removes part records', async (t) => {
  const mock = await startMock();
  t.after(() => mock.stop());
  const s = await startServer({ CHUNK_BYTES: String(CHUNK), ...mock.env });
  t.after(() => s.stop());
  const data = randomBytes(CHUNK + 5, 23);
  const tr = (await api(s.base, 'POST', '/api/transfers', { body: { files: [{ name: 'x', size: data.length }] } })).json;
  await uploadFile(s.base, tr, tr.files[0], data, { 'x-owner-token': tr.ownerToken });
  assert.equal(s.db.getParts(tr.files[0].id).length, 2);
  const removed = await s.cleanup(Date.now() + 2 * 86400000);
  assert.deepEqual(removed, [tr.id]);
  assert.equal(s.db.getParts(tr.files[0].id).length, 0);
  assert.equal((await api(s.base, 'GET', `/api/transfers/${tr.id}`)).status, 404);
});

test('s3 backend: transfer index survives losing the local disk', async (t) => {
  const mock = await startMock();
  t.after(() => mock.stop());
  const env = { CHUNK_BYTES: String(CHUNK), DB_SYNC_DEBOUNCE_MS: '10', ...mock.env };
  const s1 = await startServer(env);
  const data = randomBytes(CHUNK + 9, 24);
  const tr = (await api(s1.base, 'POST', '/api/transfers', { body: { title: 'Survivor', files: [{ name: 'keep.bin', size: data.length }] } })).json;
  const owner = { 'x-owner-token': tr.ownerToken };
  await uploadFile(s1.base, tr, tr.files[0], data, owner);
  assert.equal((await completeAndWait(s1.base, tr, owner)).status, 200);
  await s1.dbSync.flush();
  await s1.stop(); // removes its DATA_DIR entirely, like a redeploy on a diskless host

  const s2 = await startServer(env);
  t.after(() => s2.stop());
  const info = await api(s2.base, 'GET', `/api/transfers/${tr.id}`);
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json.title, 'Survivor');
  const red = await fetch(`${s2.base}/d/${tr.id}/${tr.files[0].id}`, { redirect: 'manual' });
  assert.equal(red.status, 302);
  assert.ok(Buffer.from(await (await fetch(red.headers.get('location'))).arrayBuffer()).equals(data));
  // Owner token still works after the restore.
  assert.equal((await api(s2.base, 'DELETE', `/api/transfers/${tr.id}`, { headers: owner })).status, 200);
});
