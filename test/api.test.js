import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, randomBytes, uploadFile } from './helpers.js';

const CHUNK = 64 * 1024;

test('full flow: create, chunked upload out of order, resume status, complete, info, download, zip, delete', async (t) => {
  const s = await startServer({ CHUNK_BYTES: String(CHUNK) });
  t.after(() => s.stop());

  const big = randomBytes(CHUNK * 2 + 123, 1);
  const small = randomBytes(10, 2);
  const empty = Buffer.alloc(0);

  const created = await api(s.base, 'POST', '/api/transfers', {
    body: {
      title: 'Q3 report',
      message: 'hello',
      senderEmail: 'a@b.co',
      expiresInDays: 7,
      files: [
        { name: 'reports/../big.bin', size: big.length },
        { name: 'small.txt', size: small.length },
        { name: 'nested/dir/empty.txt', size: 0 },
      ],
    },
  });
  assert.equal(created.status, 201, created.text);
  const tr = created.json;
  assert.equal(tr.chunkSize, CHUNK);
  assert.equal(tr.files[0].name, 'reports/big.bin');
  assert.equal(tr.files[0].chunksTotal, 3);
  assert.equal(tr.files[2].chunksTotal, 1);
  assert.match(tr.link, new RegExp(`/t/${tr.id}$`));
  const owner = { 'x-owner-token': tr.ownerToken };

  // Public info while uploading is refused, owner can see it.
  assert.equal((await api(s.base, 'GET', `/api/transfers/${tr.id}`)).status, 409);
  assert.equal((await api(s.base, 'GET', `/api/transfers/${tr.id}`, { headers: owner })).json.status, 'uploading');

  // Wrong owner token.
  const bad = await api(s.base, 'PUT', `/api/transfers/${tr.id}/files/${tr.files[0].id}/chunks/0`, { raw: big.subarray(0, CHUNK) });
  assert.equal(bad.status, 403);

  // Out of order chunks: 2, 0, then status shows 1 missing.
  const f0 = tr.files[0];
  const put = (n, buf) => api(s.base, 'PUT', `/api/transfers/${tr.id}/files/${f0.id}/chunks/${n}`, { raw: buf, headers: owner });
  assert.equal((await put(2, big.subarray(2 * CHUNK))).status, 200);
  assert.equal((await put(0, big.subarray(0, CHUNK))).status, 200);
  let status = await api(s.base, 'GET', `/api/transfers/${tr.id}/files/${f0.id}/status`, { headers: owner });
  assert.deepEqual(status.json.chunksDone, [0, 2]);

  // Wrong sized chunk is rejected and not counted.
  assert.equal((await put(1, big.subarray(CHUNK, CHUNK + 5))).status, 400);
  assert.equal((await put(5, big.subarray(0, 5))).status, 400);
  status = await api(s.base, 'GET', `/api/transfers/${tr.id}/files/${f0.id}/status`, { headers: owner });
  assert.deepEqual(status.json.chunksDone, [0, 2]);

  // Complete with a missing chunk reports which one.
  const incomplete = await api(s.base, 'POST', `/api/transfers/${tr.id}/complete`, { headers: owner });
  assert.equal(incomplete.status, 409);
  assert.deepEqual(incomplete.json.missing, [1]);

  assert.equal((await put(1, big.subarray(CHUNK, 2 * CHUNK))).status, 200);
  await uploadFile(s.base, tr, tr.files[1], small, owner);
  await uploadFile(s.base, tr, tr.files[2], empty, owner);

  const done = await api(s.base, 'POST', `/api/transfers/${tr.id}/complete`, { headers: owner });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.emailed, false);
  // Completing twice is harmless.
  assert.equal((await api(s.base, 'POST', `/api/transfers/${tr.id}/complete`, { headers: owner })).status, 200);
  // Uploading after completion is refused.
  assert.equal((await put(0, big.subarray(0, CHUNK))).status, 409);

  const info = await api(s.base, 'GET', `/api/transfers/${tr.id}`);
  assert.equal(info.status, 200);
  assert.equal(info.json.title, 'Q3 report');
  assert.equal(info.json.totalBytes, big.length + small.length);
  assert.equal(info.json.files.length, 3);
  assert.equal(info.json.protected, false);
  assert.equal(info.json.isOwner, false);
  assert.equal(info.json.recipients, undefined);

  // Single download, exact bytes, proper headers.
  const dl = await fetch(`${s.base}/d/${tr.id}/${f0.id}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /filename="big.bin"/);
  assert.equal(dl.headers.get('content-length'), String(big.length));
  const got = Buffer.from(await dl.arrayBuffer());
  assert.ok(got.equals(big));

  // Range request works.
  const range = await fetch(`${s.base}/d/${tr.id}/${f0.id}`, { headers: { range: 'bytes=10-19' } });
  assert.equal(range.status, 206);
  assert.ok(Buffer.from(await range.arrayBuffer()).equals(big.subarray(10, 20)));

  // Zip of everything.
  const zip = await fetch(`${s.base}/d/${tr.id}/all`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const zipBuf = Buffer.from(await zip.arrayBuffer());
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, 'zip local header');
  assert.ok(zipBuf.includes(Buffer.from('reports/big.bin')));
  assert.ok(zipBuf.includes(Buffer.from('nested/dir/empty.txt')));
  assert.ok(zipBuf.length > big.length + small.length);

  const after = await api(s.base, 'GET', `/api/transfers/${tr.id}`);
  assert.equal(after.json.downloadCount, 2);

  // Delete requires owner, then everything is gone.
  assert.equal((await api(s.base, 'DELETE', `/api/transfers/${tr.id}`)).status, 403);
  assert.equal((await api(s.base, 'DELETE', `/api/transfers/${tr.id}`, { headers: owner })).status, 200);
  assert.equal((await api(s.base, 'GET', `/api/transfers/${tr.id}`)).status, 404);
  assert.equal((await fetch(`${s.base}/d/${tr.id}/${f0.id}`)).status, 404);
});

test('password protection: unlock token gates info and downloads', async (t) => {
  const s = await startServer({ CHUNK_BYTES: String(CHUNK) });
  t.after(() => s.stop());
  const data = randomBytes(100, 3);
  const created = await api(s.base, 'POST', '/api/transfers', {
    body: { password: 'hunter2', files: [{ name: 'x.bin', size: data.length }] },
  });
  const tr = created.json;
  const owner = { 'x-owner-token': tr.ownerToken };
  await uploadFile(s.base, tr, tr.files[0], data, owner);
  assert.equal((await api(s.base, 'POST', `/api/transfers/${tr.id}/complete`, { headers: owner })).status, 200);

  const locked = await api(s.base, 'GET', `/api/transfers/${tr.id}`);
  assert.equal(locked.status, 401);
  assert.equal(locked.json.locked, true);
  assert.equal((await fetch(`${s.base}/d/${tr.id}/${tr.files[0].id}`)).status, 401);
  assert.equal((await fetch(`${s.base}/d/${tr.id}/all`)).status, 401);

  assert.equal((await api(s.base, 'POST', `/api/transfers/${tr.id}/unlock`, { body: { password: 'nope' } })).status, 401);
  const unlock = await api(s.base, 'POST', `/api/transfers/${tr.id}/unlock`, { body: { password: 'hunter2' } });
  assert.equal(unlock.status, 200);
  const token = unlock.json.token;
  assert.ok(token);

  const info = await api(s.base, 'GET', `/api/transfers/${tr.id}`, { headers: { 'x-access-token': token } });
  assert.equal(info.status, 200);
  assert.equal(info.json.protected, true);
  const dl = await fetch(`${s.base}/d/${tr.id}/${tr.files[0].id}?token=${encodeURIComponent(token)}`);
  assert.equal(dl.status, 200);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(data));
  assert.equal((await fetch(`${s.base}/d/${tr.id}/all?token=garbage.sig`)).status, 401);
  // Owner never needs the password.
  assert.equal((await api(s.base, 'GET', `/api/transfers/${tr.id}`, { headers: owner })).status, 200);
});

test('upload code gate', async (t) => {
  const s = await startServer({ UPLOAD_CODE: 'office123' });
  t.after(() => s.stop());
  const body = { files: [{ name: 'a', size: 1 }] };
  assert.equal((await api(s.base, 'POST', '/api/transfers', { body })).status, 401);
  assert.equal((await api(s.base, 'POST', '/api/transfers', { body, headers: { 'x-upload-code': 'wrong' } })).status, 401);
  assert.equal((await api(s.base, 'POST', '/api/transfers', { body, headers: { 'x-upload-code': 'office123' } })).status, 201);
  const cfg = await api(s.base, 'GET', '/api/config');
  assert.equal(cfg.json.uploadCodeRequired, true);
});

test('validation errors are clear JSON', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  let r = await api(s.base, 'POST', '/api/transfers', { body: { files: [] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /at least one file/);
  r = await api(s.base, 'POST', '/api/transfers', { body: { files: [{ name: 'a', size: 1 }], expiresInDays: 5 } });
  assert.equal(r.status, 400);
  r = await api(s.base, 'POST', '/api/transfers', { body: { files: [{ name: 'a', size: 1 }], recipients: ['not-an-email'] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not a valid email/);
  r = await api(s.base, 'POST', '/api/transfers', { body: { files: [{ name: 'a', size: -1 }] } });
  assert.equal(r.status, 400);
  r = await api(s.base, 'GET', '/api/transfers/doesnotexist');
  assert.equal(r.status, 404);
  const raw = await fetch(`${s.base}/api/transfers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(raw.status, 400);
});

test('size limit is enforced when configured', async (t) => {
  const s = await startServer({ MAX_TRANSFER_GB: '1' });
  t.after(() => s.stop());
  const r = await api(s.base, 'POST', '/api/transfers', { body: { files: [{ name: 'huge', size: 2 * 1024 ** 3 }] } });
  assert.equal(r.status, 413);
});

test('expiry and abandoned-upload cleanup remove rows and files', async (t) => {
  const s = await startServer({ CHUNK_BYTES: String(CHUNK) });
  t.after(() => s.stop());
  const data = randomBytes(50, 4);

  const mk = async (expiresInDays) => {
    const c = await api(s.base, 'POST', '/api/transfers', { body: { expiresInDays, files: [{ name: 'f', size: data.length }] } });
    return c.json;
  };
  const expiring = await mk(1);
  const forever = await mk(0);
  const abandoned = await mk(7);
  for (const tr of [expiring, forever]) {
    const owner = { 'x-owner-token': tr.ownerToken };
    await uploadFile(s.base, tr, tr.files[0], data, owner);
    await api(s.base, 'POST', `/api/transfers/${tr.id}/complete`, { headers: owner });
  }
  await uploadFile(s.base, abandoned, abandoned.files[0], data, { 'x-owner-token': abandoned.ownerToken });

  // Nothing is due yet.
  assert.deepEqual(await s.cleanup(Date.now()), []);
  // Two days later the 1-day transfer and the abandoned upload are gone; the never-expiring one stays.
  const removed = await s.cleanup(Date.now() + 2 * 86400000);
  assert.deepEqual(new Set(removed), new Set([expiring.id, abandoned.id]));
  assert.equal((await api(s.base, 'GET', `/api/transfers/${expiring.id}`)).status, 404);
  assert.equal((await api(s.base, 'GET', `/api/transfers/${forever.id}`)).status, 200);
  assert.equal(s.db.getFiles(abandoned.id).length, 0);
  assert.equal((await s.storage.chunkStatus(abandoned.files[0].id)).size, 0);

  // Expired transfers answer 410 before cleanup runs.
  s.db.raw.prepare('UPDATE transfers SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, forever.id);
  assert.equal((await api(s.base, 'GET', `/api/transfers/${forever.id}`)).status, 410);
});

test('static pages and qr are served', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const home = await fetch(`${s.base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  const page = await fetch(`${s.base}/t/anything`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  const qr = await fetch(`${s.base}/api/transfers/abc/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /svg/);
  assert.equal((await api(s.base, 'GET', '/api/health')).json.ok, true);
});
