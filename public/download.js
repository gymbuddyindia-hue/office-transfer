(() => {
  const { $, formatBytes, formatDate, expiryText, apiFetch, owners, forgetOwner, copyText } = OT;
  const id = location.pathname.split('/').filter(Boolean).pop();
  const tokenKey = `ot.token.${id}`;
  const owner = owners()[id];
  let token = sessionStorage.getItem(tokenKey) || '';

  const show = (which) => {
    for (const s of ['loading', 'locked', 'gone', 'ready']) $(s).classList.toggle('hidden', s !== which);
  };

  function authHeaders() {
    const h = {};
    if (owner) h['X-Owner-Token'] = owner.ownerToken;
    if (token) h['X-Access-Token'] = token;
    return h;
  }
  function withToken(url) {
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
  }

  async function load() {
    show('loading');
    let t;
    try {
      t = await apiFetch(`/api/transfers/${id}`, { headers: authHeaders() });
    } catch (err) {
      if (err.status === 401 && err.body && err.body.locked) {
        $('lockedTitle').textContent = err.body.title ? `"${err.body.title}"` : '';
        sessionStorage.removeItem(tokenKey); token = '';
        return show('locked');
      }
      $('goneTitle').textContent = err.status === 410 ? 'This transfer has expired' : err.status === 409 ? 'Not ready yet' : 'Transfer not found';
      $('goneText').textContent = err.status === 409 ? 'The sender has not finished uploading yet. Try again in a moment.' : err.message;
      if (err.status === 404 || err.status === 410) forgetOwner(id);
      return show('gone');
    }
    render(t);
  }

  function render(t) {
    if (t.accessToken) token = t.accessToken;
    document.title = t.title ? `${t.title} | Download` : 'Download files';
    $('title').textContent = t.title || `${t.files.length} file${t.files.length === 1 ? '' : 's'} for you`;
    $('from').textContent = t.senderEmail ? `From ${t.senderEmail}` : 'Shared with you';
    $('count').textContent = `${t.files.length} file${t.files.length === 1 ? '' : 's'}, ${formatBytes(t.totalBytes)}`;
    $('expires').textContent = expiryText(t.expiresAt);
    $('downloads').textContent = t.downloadCount ? `Downloaded ${t.downloadCount} time${t.downloadCount === 1 ? '' : 's'}` : '';
    $('message').textContent = t.message || '';
    $('message').classList.toggle('hidden', !t.message);
    const ul = $('list');
    ul.innerHTML = '';
    for (const f of t.files) {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name; name.title = f.name;
      const size = document.createElement('span'); size.className = 'size muted'; size.textContent = formatBytes(f.size);
      const a = document.createElement('a'); a.className = 'get'; a.textContent = 'Download'; a.href = withToken(`/d/${id}/${f.id}`); a.setAttribute('download', f.name.split('/').pop());
      li.append(name, size, a);
      ul.appendChild(li);
    }
    $('downloadAll').href = withToken(`/d/${id}/all`);
    $('downloadAll').textContent = t.files.length === 1 ? 'Download' : `Download all ${t.files.length} files (.zip)`;
    if (t.files.length === 1) $('downloadAll').href = withToken(`/d/${id}/${t.files[0].id}`);
    if (t.isOwner) {
      $('owner').classList.remove('hidden');
      $('ownerLink').value = location.href.split('?')[0];
    }
    show('ready');
  }

  $('unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('unlockError').textContent = '';
    try {
      const r = await apiFetch(`/api/transfers/${id}/unlock`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value }),
      });
      token = r.token || '';
      if (token) sessionStorage.setItem(tokenKey, token);
      load();
    } catch (err) {
      $('unlockError').textContent = err.message;
    }
  });
  $('copy').addEventListener('click', async () => {
    const ok = await copyText($('ownerLink').value);
    $('copy').textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { $('copy').textContent = 'Copy link'; }, 1500);
  });
  $('delete').addEventListener('click', async () => {
    if (!confirm('Delete this transfer and its files for everyone?')) return;
    try {
      await apiFetch(`/api/transfers/${id}`, { method: 'DELETE', headers: authHeaders() });
      forgetOwner(id);
      location.href = '/';
    } catch (err) { alert(err.message); }
  });

  // Reload stats (download count) when the tab regains focus.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('ready').classList.contains('hidden')) load(); });
  load();
})();
