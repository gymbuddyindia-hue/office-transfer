/* Shared helpers for both pages. */
window.OT = (() => {
  function formatBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1; let v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
  }
  function formatDate(ms) {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function expiryText(expiresAt) {
    if (!expiresAt) return 'This link never expires.';
    const left = expiresAt - Date.now();
    if (left <= 0) return 'This link has expired.';
    const days = Math.round(left / 86400000);
    const hours = Math.floor((left % 86400000) / 3600000);
    const when = formatDate(expiresAt);
    if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'} (${when}).`;
    return `Expires in ${Math.max(hours, 1)} hour${hours === 1 ? '' : 's'} (${when}).`;
  }
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };
  const OWNERS_KEY = 'ot.owners';
  function owners() { return store.get(OWNERS_KEY, {}); }
  function rememberOwner(id, record) { const o = owners(); o[id] = record; store.set(OWNERS_KEY, o); }
  function forgetOwner(id) { const o = owners(); delete o[id]; store.set(OWNERS_KEY, o); }

  async function apiFetch(url, opts = {}) {
    const res = await fetch(url, opts);
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = { error: text || res.statusText }; }
    if (!res.ok) {
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  }
  const $ = (id) => document.getElementById(id);
  return { formatBytes, formatDate, expiryText, store, owners, rememberOwner, forgetOwner, apiFetch, copyText, $ };
})();
