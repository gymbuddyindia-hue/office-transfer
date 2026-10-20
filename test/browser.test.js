/* Real-browser test. Skipped automatically when no Chromium is available. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, randomBytes } from './helpers.js';

const CHUNK = 256 * 1024;

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    ...fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`) : [],
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

let chromium;
try { ({ chromium } = await import('playwright-core')); } catch { chromium = null; }
const exe = findChromium();
const skip = !chromium || !exe ? 'playwright-core or Chromium not available' : false;

test('browser: upload with retry, download page, password unlock, delete', { skip }, async (t) => {
  const s = await startServer({ CHUNK_BYTES: String(CHUNK), UPLOAD_CODE: 'staff' });
  t.after(() => s.stop());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-browser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bigData = randomBytes(CHUNK * 3 + 777, 11);
  const smallData = Buffer.from('hello office');
  fs.writeFileSync(path.join(dir, 'big.bin'), bigData);
  fs.writeFileSync(path.join(dir, 'notes.txt'), smallData);

  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Fail the first attempt of chunk 1 to prove the client retries.
  let failed = false;
  await page.route(/\/chunks\/1$/, (route) => {
    if (!failed) { failed = true; return route.abort('connectionreset'); }
    return route.continue();
  });

  await page.goto(`${s.base}/`);
  await page.setInputFiles('#fileInput', [path.join(dir, 'big.bin'), path.join(dir, 'notes.txt')]);
  await page.waitForSelector('#fileList li:nth-child(2)');
  assert.equal(await page.textContent('#fileCount'), '2 files');
  await page.fill('#title', 'Browser test');
  await page.fill('#message', 'from playwright');
  await page.fill('#senderEmail', 'me@office.test');
  await page.click('details.options summary');
  await page.fill('#password', 'secret');
  await page.selectOption('#expiry', '3');

  // Missing upload code is reported inline, no request made.
  await page.click('#send');
  assert.match(await page.textContent('#error'), /upload code/i);
  await page.fill('#uploadCode', 'staff');
  await page.click('#send');

  await page.waitForSelector('#doneCard:not(.hidden)', { timeout: 30000 });
  assert.ok(failed, 'chunk 1 was aborted once');
  const link = await page.inputValue('#doneLink');
  assert.match(link, /\/t\/[A-Za-z0-9_-]{22}$/);
  assert.equal(await page.textContent('#percent'), '100%');
  assert.ok((await page.innerHTML('#qr')).includes('<svg'));
  const id = link.split('/').pop();
  assert.equal(s.db.getTransfer(id).status, 'ready');

  // Recent list shows it.
  assert.ok((await page.textContent('#recentList')).includes('Browser test'));

  // Download page as the sender (same browser): no password prompt, owner tools visible.
  await page.goto(link);
  await page.waitForSelector('#ready:not(.hidden)');
  assert.equal(await page.textContent('#title'), 'Browser test');
  assert.ok(!(await page.$eval('#owner', (el) => el.classList.contains('hidden'))));

  // A stranger must enter the password.
  const stranger = await (await browser.newContext({ acceptDownloads: true })).newPage();
  stranger.on('pageerror', (e) => errors.push(e.message));
  await stranger.goto(link);
  await stranger.waitForSelector('#locked:not(.hidden)');
  await stranger.fill('#pw', 'wrong');
  await stranger.click('#unlockForm button');
  await stranger.waitForFunction(() => document.getElementById('unlockError').textContent.length > 0);
  await stranger.fill('#pw', 'secret');
  await stranger.click('#unlockForm button');
  await stranger.waitForSelector('#ready:not(.hidden)');
  assert.equal(await stranger.textContent('#message'), 'from playwright');
  assert.equal(await stranger.$$eval('#list li', (els) => els.length), 2);

  // Single file download gives back the exact bytes.
  const [dl] = await Promise.all([
    stranger.waitForEvent('download'),
    stranger.click('#list li:nth-child(1) a.get'),
  ]);
  assert.equal(dl.suggestedFilename(), 'big.bin');
  const saved = await dl.path();
  assert.ok(fs.readFileSync(saved).equals(bigData));

  // Zip download starts and is a zip.
  const [zipDl] = await Promise.all([stranger.waitForEvent('download'), stranger.click('#downloadAll')]);
  assert.match(zipDl.suggestedFilename(), /\.zip$/);
  const zipBuf = fs.readFileSync(await zipDl.path());
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50);

  // Sender deletes; stranger now sees not found.
  page.on('dialog', (d) => d.accept());
  await page.click('#delete');
  await page.waitForURL(`${s.base}/`);
  await stranger.reload();
  await stranger.waitForSelector('#gone:not(.hidden)');
  assert.equal(await stranger.textContent('#goneTitle'), 'Transfer not found');

  assert.deepEqual(errors, []);
});
