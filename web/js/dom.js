// Core DOM/fetch helpers shared across the app.
//   $(id)      — document.getElementById shorthand
//   api(u,opt) — fetch wrapper that tags every request with the current locale
//                (X-Lang) and rejects with the server's error message on !ok.
//                On error the thrown Error also carries `.status` (HTTP code)
//                and `.body` (parsed JSON) so callers can branch on them
//                (e.g. delRepo reads body.liveCount to offer a force delete).

export const $ = (id) => document.getElementById(id);

export const api = (u, opt = {}) => fetch(u, { ...opt, headers: { ...(opt.headers || {}), "X-Lang": I18N.lang } })
  .then(async r => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || r.status); e.status = r.status; e.body = j; throw e; }
    return j;
  });
