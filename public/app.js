/* Upload page: file picking, resumable chunked upload, done state, recent list. */
(() => {
  const { $, formatBytes, expiryText, store, rememberOwner, forgetOwner, owners, apiFetch, copyText } = OT;
  const PENDING_KEY = 'ot.pending';
  const CODE_KEY = 'ot.uploadCode';
  const SENDER_KEY = 'ot.senderEmail';
  const PARALLEL = 4;
  const MAX_RETRIES = 5;

  let config = { uploadCodeRequired: false, emailEnabled: false, defaultExpiryDays: 7, maxTransferBytes: 0 };
  let picked = []; // { file, name, size }
  let run = null;  // current upload run state

  function showError(msg) { $('error').textContent = msg || ''; }

  // ---------- file picking ----------
  function addFiles(list, relative = false) {
    for (const file of list) {
      const name = relative && file.webkitRelativePath ? file.webkitRelativePath : file.name;
      if (picked.some((p) => p.name === name && p.size === file.size)) continue;
      picked.push({ file, name, size: file.size });
    }
    renderFiles();
  }
  function renderFiles() {
    const ul = $('fileList');
    ul.innerHTML = '';
    let total = 0;
    picked.forEach((p, i) => {
      total += p.size;
      const li = document.createElement('li');
      li.innerHTML = `<span class="name"></span><span class="size"></span><button class="rm" title="Remove" aria-label="Remove">&times;</button>`;
      li.querySelector('.name').textContent = p.name;
      li.querySelector('.size').textContent = formatBytes(p.size);
      li.querySelector('.rm').onclick = () => { picked.splice(i, 1); renderFiles(); };
      ul.appendChild(li);
    });
    $('summary').classList.toggle('hidden', picked.length === 0);
    $('fileCount').textContent = `${picked.length} file${picked.length === 1 ? '' : 's'}`;
    $('totalSize').textContent = formatBytes(total);
    const tooBig = config.maxTransferBytes && total > config.maxTransferBytes;
    $('send').disabled = picked.length === 0 || tooBig;
    showError(tooBig ? `Total size is over the server limit of ${formatBytes(config.maxTransferBytes)}.` : '');
    checkResumable();
  }
  async function readDroppedItems(items) {
    // Walk dropped folders so drag-and-drop of a directory works in Chromium/Firefox.
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, name: prefix + file.name, size: file.size });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
        } while (batch.length);
      }
    };
    const entries = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) entries.push(entry); else if (item.getAsFile()) out.push({ file: item.getAsFile(), name: item.getAsFile().name, size: item.getAsFile().size });
    }
    for (const e of entries) await walk(e, '');
    return out;
  }

  const dz = $('dropzone');
  dz.addEventListener('click', (e) => { if (e.target.id !== 'pickFolder') $('fileInput').click(); });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
  $('pickFolder').addEventListener('click', (e) => { e.stopPropagation(); $('folderInput').click(); });
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('folderInput').addEventListener('change', (e) => { addFiles(e.target.files, true); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; dz.classList.remove('over'); }));
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    if (e.dataTransfer.items && e.dataTransfer.items.length && e.dataTransfer.items[0].webkitGetAsEntry) {
      const entries = await readDroppedItems(e.dataTransfer.items);
      for (const p of entries) if (!picked.some((q) => q.name === p.name && q.size === p.size)) picked.push(p);
      renderFiles();
    } else {
      addFiles(e.dataTransfer.files);
    }
  });

  // ---------- resume of an interrupted transfer ----------
  function pending() { return store.get(PENDING_KEY, null); }
  function matchesPending(p) {
    if (!p || p.files.length !== picked.length) return false;
    return p.files.every((pf) => picked.some((q) => q.name === pf.name && q.size === pf.size));
  }
  function checkResumable() {
    const p = pending();
    const n = $('resumeNotice');
    if (!p) { n.classList.add('hidden'); return; }
    n.classList.remove('hidden');
    if (matchesPending(p)) {
      n.textContent = 'These match an interrupted upload. Press Transfer to resume where it stopped.';
    } else {
      n.innerHTML = '';
      n.append(`An earlier upload (${p.files.length} file${p.files.length === 1 ? '' : 's'}, ${formatBytes(p.files.reduce((a, f) => a + f.size, 0))}) was interrupted. Add the same files to resume it, or `);
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = 'discard it'; b.className = 'linkish';
      b.style.cssText = 'background:none;border:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit;padding:0';
      b.onclick = () => { store.del(PENDING_KEY); checkResumable(); };
      n.append(b, '.');
    }
  }

  // ---------- upload engine ----------
  function putChunk(url, blob, headers, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let msg = `HTTP ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep */ }
        const err = new Error(msg); err.status = xhr.status; reject(err);
      };
      xhr.onerror = () => reject(Object.assign(new Error('Network error'), { retryable: true }));
      xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      xhr.ontimeout = () => reject(Object.assign(new Error('Timed out'), { retryable: true }));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(blob);
    });
  }

  async function startUpload() {
    showError('');
    const code = $('uploadCode').value.trim();
    if (config.uploadCodeRequired && !code) return showError('Enter the staff upload code.');
    if (code) store.set(CODE_KEY, code);
    const recipients = $('recipients').value.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
    const senderEmail = $('senderEmail').value.trim();
    if (senderEmail) store.set(SENDER_KEY, senderEmail);
    if (recipients.length && !senderEmail) return showError('Add your email so recipients know who sent this.');
    const headers = code ? { 'X-Upload-Code': code } : {};

    let tr = pending();
    if (!matchesPending(tr)) {
      try {
        tr = await apiFetch('/api/transfers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            title: $('title').value.trim(),
            message: $('message').value.trim(),
            senderEmail,
            recipients,
            expiresInDays: Number($('expiry').value),
            password: $('password').value,
            files: picked.map((p) => ({ name: p.name, size: p.size })),
          }),
        });
      } catch (err) {
        return showError(err.message);
      }
      store.set(PENDING_KEY, tr);
    }
    runUpload(tr);
  }

  function runUpload(tr) {
    const owner = { 'X-Owner-Token': tr.ownerToken };
    const controller = new AbortController();
    const files = tr.files.map((f) => {
      // Server sanitised the name; match by original index (same order as submitted).
      const local = picked.find((p) => p.size === f.size && (p.name === f.name || sanitiseLike(p.name) === f.name));
      return { ...f, blob: local.file, done: new Set(), inflight: new Map() };
    });
    run = { tr, files, controller, startedAt: Date.now(), startedBytes: 0 };

    $('composer').classList.add('hidden');
    $('doneCard').classList.add('hidden');
    $('progressCard').classList.remove('hidden');
    $('progressError').textContent = '';
    $('retry').style.display = 'none';
    $('cancel').disabled = false;
    $('progressTitle').textContent = 'Uploading';
    const list = $('progressList');
    list.innerHTML = '';
    for (const f of files) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="name"></span><span class="bar"><i></i></span><span class="size"></span>`;
      li.querySelector('.name').textContent = f.name;
      li.querySelector('.size').textContent = formatBytes(f.size);
      f.el = li.querySelector('.bar i');
      list.appendChild(li);
    }

    (async () => {
      try {
        // Ask the server which chunks already exist, so a retry or resume skips them.
        for (const f of files) {
          const st = await apiFetch(`/api/transfers/${tr.id}/files/${f.id}/status`, { headers: owner, signal: controller.signal });
          f.done = new Set(st.chunksDone);
          if (st.assembled) for (let i = 0; i < f.chunksTotal; i++) f.done.add(i);
        }
        run.startedBytes = doneBytes();
        run.startedAt = Date.now();
        paint();

        const queue = [];
        for (const f of files) for (let n = 0; n < f.chunksTotal; n++) if (!f.done.has(n)) queue.push({ f, n });
        let failure = null;
        const worker = async () => {
          while (queue.length && !failure && !controller.signal.aborted) {
            const { f, n } = queue.shift();
            const start = n * tr.chunkSize;
            const blob = f.blob.slice(start, Math.min(f.size, start + tr.chunkSize));
            for (let attempt = 0; ; attempt++) {
              try {
                await putChunk(`/api/transfers/${tr.id}/files/${f.id}/chunks/${n}`, blob, owner,
                  (loaded) => { f.inflight.set(n, loaded); paint(); }, controller.signal);
                f.inflight.delete(n); f.done.add(n); paint();
                break;
              } catch (err) {
                f.inflight.delete(n);
                if (err.cancelled) return;
                const retryable = err.retryable || (err.status >= 500 && err.status !== 507) || err.status === 429;
                if (!retryable || attempt >= MAX_RETRIES) { failure = err; return; }
                $('progressFile').textContent = `Connection problem, retrying (${attempt + 1}/${MAX_RETRIES})`;
                await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
              }
            }
          }
        };
        await Promise.all(Array.from({ length: PARALLEL }, worker));
        if (controller.signal.aborted) return;
        if (failure) throw failure;

        $('progressTitle').textContent = 'Finishing';
        $('progressFile').textContent = 'Assembling files on the server';
        $('cancel').disabled = true;
        let done = await apiFetch(`/api/transfers/${tr.id}/complete`, { method: 'POST', headers: owner });
        // Assembly runs on the server in the background; poll until it reports ready.
        while (done.status !== 'ready') {
          await new Promise((r) => setTimeout(r, 1500));
          const info = await apiFetch(`/api/transfers/${tr.id}`, { headers: owner });
          if (info.finishError) throw new Error(info.finishError);
          if (info.status === 'ready') done = { ...done, status: 'ready', link: info.link, emailed: info.emailed, emailError: info.emailError, recipients: info.recipients };
          else if (info.status === 'uploading') throw new Error('The server could not finish the transfer. Press Retry.');
        }
        store.del(PENDING_KEY);
        rememberOwner(tr.id, {
          ownerToken: tr.ownerToken, link: done.link, title: $('title').value.trim() || files.map((f) => f.name).join(', ').slice(0, 60),
          expiresAt: tr.expiresAt, totalBytes: files.reduce((a, f) => a + f.size, 0), createdAt: Date.now(), count: files.length,
        });
        showDone(tr, done, files);
      } catch (err) {
        if (err.cancelled || controller.signal.aborted) return;
        $('progressTitle').textContent = 'Upload stopped';
        $('progressError').textContent = err.message + (err.status === 507 ? ' Ask your admin to free space.' : '');
        $('retry').style.display = '';
      }
    })();
  }

  function sanitiseLike(name) {
    return name.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]+/).map((p) => p.trim()).filter((p) => p && p !== '.' && p !== '..').join('/') || 'file';
  }
  function doneBytes() {
    let b = 0;
    for (const f of run.files) {
      for (const n of f.done) b += n === f.chunksTotal - 1 ? f.size - n * run.tr.chunkSize : run.tr.chunkSize;
      for (const v of f.inflight.values()) b += v;
    }
    return b;
  }
  let lastPaint = 0;
  function paint(force) {
    const now = performance.now();
    if (!force && now - lastPaint < 100) return;
    lastPaint = now;
    const total = run.files.reduce((a, f) => a + f.size, 0) || 1;
    const done = Math.min(total, doneBytes());
    const pct = Math.floor((done / total) * 100);
    $('percent').textContent = `${pct}%`;
    $('ring').style.background = `conic-gradient(var(--accent) ${pct * 3.6}deg, var(--soft) 0deg)`;
    const elapsed = (Date.now() - run.startedAt) / 1000;
    const rate = elapsed > 0.5 ? (done - run.startedBytes) / elapsed : 0;
    const left = rate > 0 ? (total - done) / rate : null;
    $('progressStat').textContent = `${formatBytes(done)} of ${formatBytes(total)}` + (rate ? ` at ${formatBytes(rate)}/s` : '') + (left !== null && left > 1 ? `, about ${fmtTime(left)} left` : '');
    for (const f of run.files) {
      let fb = 0;
      for (const n of f.done) fb += n === f.chunksTotal - 1 ? f.size - n * run.tr.chunkSize : run.tr.chunkSize;
      for (const v of f.inflight.values()) fb += v;
      f.el.style.width = `${f.size ? Math.min(100, (fb / f.size) * 100) : 100}%`;
    }
    const current = run.files.find((f) => f.inflight.size);
    if (current) $('progressFile').textContent = current.name;
  }
  function fmtTime(s) {
    if (s < 60) return `${Math.ceil(s)} s`;
    if (s < 3600) return `${Math.ceil(s / 60)} min`;
    return `${(s / 3600).toFixed(1)} h`;
  }

  $('cancel').addEventListener('click', async () => {
    if (!run) return;
    run.controller.abort();
    const { tr } = run;
    run = null;
    store.del(PENDING_KEY);
    try { await apiFetch(`/api/transfers/${tr.id}`, { method: 'DELETE', headers: { 'X-Owner-Token': tr.ownerToken } }); } catch { /* server cleanup will handle it */ }
    $('progressCard').classList.add('hidden');
    $('composer').classList.remove('hidden');
    checkResumable();
  });
  $('retry').addEventListener('click', () => { if (run) runUpload(run.tr); });

  // ---------- done state ----------
  async function showDone(tr, done, files) {
    $('progressCard').classList.add('hidden');
    $('doneCard').classList.remove('hidden');
    const total = files.reduce((a, f) => a + f.size, 0);
    $('doneSummary').textContent = `${files.length} file${files.length === 1 ? '' : 's'}, ${formatBytes(total)}. Share this link:`;
    $('doneLink').value = done.link;
    $('openLink').href = done.link;
    $('doneExpiry').textContent = expiryText(tr.expiresAt);
    $('doneEmail').textContent = done.emailed
      ? `Emailed to ${done.recipients.join(', ')}.`
      : done.emailError ? `Email failed (${done.emailError}). Send the link yourself.`
      : done.recipients && done.recipients.length ? 'Email sending is not set up on this server. Send the link yourself.' : '';
    $('qr').innerHTML = '';
    try {
      const svg = await fetch(`/api/transfers/${tr.id}/qr.svg`).then((r) => r.text());
      $('qr').innerHTML = svg;
    } catch { /* qr is optional */ }
    $('deleteDone').onclick = async () => {
      if (!confirm('Delete this transfer and its files for everyone?')) return;
      try {
        await apiFetch(`/api/transfers/${tr.id}`, { method: 'DELETE', headers: { 'X-Owner-Token': tr.ownerToken } });
        forgetOwner(tr.id);
        resetComposer();
      } catch (err) { alert(err.message); }
    };
    renderRecent();
  }
  $('copy').addEventListener('click', async () => {
    const ok = await copyText($('doneLink').value);
    $('copy').textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { $('copy').textContent = 'Copy link'; }, 1500);
  });
  $('another').addEventListener('click', resetComposer);
  function resetComposer() {
    picked = []; run = null;
    renderFiles();
    $('title').value = ''; $('message').value = ''; $('recipients').value = ''; $('password').value = '';
    $('doneCard').classList.add('hidden');
    $('progressCard').classList.add('hidden');
    $('composer').classList.remove('hidden');
    renderRecent();
  }

  // ---------- recent list ----------
  function renderRecent() {
    const o = owners();
    const ul = $('recentList');
    ul.innerHTML = '';
    const items = Object.entries(o).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 20);
    $('recent').classList.toggle('hidden', items.length === 0);
    for (const [id, r] of items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = r.link; a.textContent = `${r.title || id} (${r.count} file${r.count === 1 ? '' : 's'}, ${formatBytes(r.totalBytes)})`;
      const exp = document.createElement('span');
      exp.textContent = r.expiresAt ? (r.expiresAt < Date.now() ? 'expired' : `until ${new Date(r.expiresAt).toLocaleDateString()}`) : 'no expiry';
      exp.style.opacity = '.75';
      const del = document.createElement('button');
      del.title = 'Delete transfer'; del.innerHTML = '&times;';
      del.onclick = async () => {
        if (!confirm('Delete this transfer and its files for everyone?')) return;
        try { await apiFetch(`/api/transfers/${id}`, { method: 'DELETE', headers: { 'X-Owner-Token': r.ownerToken } }); } catch (err) { if (err.status !== 404 && err.status !== 410) return alert(err.message); }
        forgetOwner(id); renderRecent();
      };
      li.append(a, exp, del);
      ul.appendChild(li);
    }
  }

  // ---------- init ----------
  $('send').addEventListener('click', startUpload);
  window.addEventListener('beforeunload', (e) => { if (run && !run.controller.signal.aborted && !$('progressCard').classList.contains('hidden')) { e.preventDefault(); e.returnValue = ''; } });
  (async () => {
    try { config = await apiFetch('/api/config'); } catch { /* defaults */ }
    document.title = config.appName || document.title;
    $('brandName').textContent = config.appName || 'Office Transfer';
    $('expiry').value = String(config.defaultExpiryDays ?? 7);
    $('uploadCodeField').classList.toggle('hidden', !config.uploadCodeRequired);
    $('uploadCode').value = store.get(CODE_KEY, '');
    $('senderEmail').value = store.get(SENDER_KEY, '');
    $('emailHint').textContent = config.emailEnabled ? 'Recipients get the link by email.' : 'Email is not set up on this server, so you will copy the link and send it yourself.';
    renderFiles();
    renderRecent();
  })();
})();
