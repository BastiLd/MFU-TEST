'use strict';
/* ============================================================
   WebHafen — UI (SPA, kein Framework)
   ============================================================ */

const $ = sel => document.querySelector(sel);
const app = $('#app');
let SITES = [];
let OVERVIEW = null;
let liveTimer = null;

/* ---------------------------- Helfer ---------------------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n) {
  n = +n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace('.', ',') + ' k';
  return n.toLocaleString('de-AT');
}
function fmtBytes(b) {
  b = +b || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i ? b.toFixed(1).replace('.', ',') : b) + ' ' + u[i];
}
function fmtMs(sec) { return Math.round((+sec || 0) * 1000) + ' ms'; }
function fmtDateShort(d) { const [, m, day] = d.split('-'); return day + '.' + m + '.'; }
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 4200);
}
async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'X-WH': '1' }, opts.headers || {});
  if (opts.json !== undefined) {
    opts.body = JSON.stringify(opts.json);
    opts.headers['Content-Type'] = 'application/json';
    delete opts.json;
  }
  const r = await fetch(path, opts);
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (r.status === 401 && path !== '/api/me') { renderLogin(); throw new Error('Nicht angemeldet'); }
  if (!r.ok || data.ok === false) throw new Error(data.error || ('Fehler ' + r.status));
  if (data.caddyError) toast('⚠️ Caddy: ' + data.caddyError, 'err');
  return data;
}
function siteURL(site) { return 'http://' + location.hostname + ':' + site.port; }
function stopTimers() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

/* Animierte Zahlen */
function animateCounters(root) {
  (root || document).querySelectorAll('[data-count]').forEach(el => {
    const target = +el.dataset.count || 0;
    const suffix = el.dataset.suffix || '';
    const t0 = performance.now(), dur = 900;
    const step = t => {
      const p = Math.min(1, (t - t0) / dur);
      const v = Math.round(target * (1 - Math.pow(1 - p, 3)));
      el.textContent = fmtNum(v) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
/* 3D-Tilt für Karten */
function attachTilt(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  (root || document).querySelectorAll('[data-tilt]').forEach(card => {
    const max = 6;
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      card.style.transform = 'perspective(900px) rotateX(' + (-y * max) + 'deg) rotateY(' + (x * max) + 'deg) translateY(-2px)';
    });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  });
}

/* ---------------------------- Charts (SVG) ---------------------------- */
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = 'M' + pts[0][0] + ',' + pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += 'C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ',' + c2y.toFixed(1) + ' ' + p2[0] + ',' + p2[1];
  }
  return d;
}
function areaChart(days) {
  const W = 820, H = 250, P = 34;
  const max = Math.max(5, ...days.map(d => d.pv));
  const X = i => P + i * ((W - P * 2) / Math.max(1, days.length - 1));
  const Y = v => H - P - (v / max) * (H - P * 2);
  const pv = days.map((d, i) => [X(i), Y(d.pv)]);
  const vi = days.map((d, i) => [X(i), Y(d.visitors)]);
  const gridLines = [0, .25, .5, .75, 1].map(f => {
    const y = Y(max * f);
    return '<line x1="' + P + '" y1="' + y + '" x2="' + (W - P) + '" y2="' + y + '" stroke="rgba(255,255,255,.06)"/>' +
      '<text x="' + (P - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#96a0b8">' + fmtNum(Math.round(max * f)) + '</text>';
  }).join('');
  const labels = days.map((d, i) => {
    if (days.length > 14 && i % Math.ceil(days.length / 10) !== 0) return '';
    return '<text x="' + X(i) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="#96a0b8">' + fmtDateShort(d.date) + '</text>';
  }).join('');
  const dots = days.map((d, i) =>
    '<circle cx="' + X(i) + '" cy="' + Y(d.pv) + '" r="8" fill="transparent"><title>' + fmtDateShort(d.date) + ' — ' +
    d.pv + ' Aufrufe, ' + d.visitors + ' Besucher</title></circle>').join('');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="draw">' +
    '<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#818cf8" stop-opacity=".35"/><stop offset="1" stop-color="#818cf8" stop-opacity="0"/></linearGradient>' +
    '<linearGradient id="gl" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#c084fc"/></linearGradient></defs>' +
    gridLines +
    '<path d="' + smoothPath(pv) + ' L' + (W - P) + ',' + (H - P) + ' L' + P + ',' + (H - P) + ' Z" fill="url(#ga)" stroke="none"/>' +
    '<path class="line" d="' + smoothPath(pv) + '" fill="none" stroke="url(#gl)" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="' + smoothPath(vi) + '" fill="none" stroke="#34d399" stroke-width="2" stroke-dasharray="5 5" opacity=".8"/>' +
    labels + dots + '</svg>';
}
function hourBars(hours) {
  const W = 820, H = 150, P = 26;
  const max = Math.max(3, ...hours);
  const bw = (W - P * 2) / 24;
  const bars = hours.map((v, h) => {
    const bh = (v / max) * (H - P * 2);
    return '<rect x="' + (P + h * bw + 2).toFixed(1) + '" y="' + (H - P - bh).toFixed(1) + '" width="' + (bw - 4).toFixed(1) +
      '" height="' + Math.max(1.5, bh).toFixed(1) + '" rx="4" fill="url(#gb)" opacity="' + (v ? '1' : '.25') + '">' +
      '<title>' + h + ' Uhr — ' + v + ' Aufrufe</title></rect>' +
      (h % 3 === 0 ? '<text x="' + (P + h * bw + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="9" fill="#96a0b8">' + h + '</text>' : '');
  }).join('');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '">' +
    '<defs><linearGradient id="gb" x1="0" y1="1" x2="0" y2="0">' +
    '<stop offset="0" stop-color="#22d3ee" stop-opacity=".5"/><stop offset="1" stop-color="#818cf8"/></linearGradient></defs>' +
    bars + '</svg>';
}
function donut(entries) {
  const total = entries.reduce((a, e) => a + e.value, 0) || 1;
  const R = 54, C = 2 * Math.PI * R;
  let off = 0;
  const segs = entries.filter(e => e.value > 0).map(e => {
    const frac = e.value / total;
    const seg = '<circle cx="80" cy="80" r="' + R + '" fill="none" stroke="' + e.color + '" stroke-width="20" ' +
      'stroke-dasharray="' + (frac * C - 2).toFixed(1) + ' ' + (C - frac * C + 2).toFixed(1) + '" ' +
      'stroke-dashoffset="' + (-off * C + C / 4).toFixed(1) + '"><title>' + esc(e.label) + ': ' + fmtNum(e.value) + '</title></circle>';
    off += frac;
    return seg;
  }).join('');
  const legend = entries.map(e =>
    '<div><i style="background:' + e.color + ';display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px"></i>' +
    esc(e.label) + ' <b style="font-family:Sora">' + fmtNum(e.value) + '</b></div>').join('');
  return '<div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">' +
    '<svg viewBox="0 0 160 160" style="width:150px;flex-shrink:0">' + segs +
    '<text x="80" y="86" text-anchor="middle" font-size="20" font-weight="800" fill="#eef1f8" font-family="Sora">' + fmtNum(total) + '</text></svg>' +
    '<div style="display:grid;gap:8px;font-size:.86rem;color:#96a0b8">' + legend + '</div></div>';
}
function listBars(pairs, unit) {
  if (!pairs.length) return '<p class="muted" style="padding:14px 0">Noch keine Daten.</p>';
  const max = pairs[0][1] || 1;
  return pairs.map(([k, v]) =>
    '<div class="hbar"><div class="track"><div class="fill" style="width:' + Math.max(3, v / max * 100) + '%"></div>' +
    '<span class="txt" title="' + esc(k) + '">' + esc(k) + '</span></div><b>' + fmtNum(v) + (unit || '') + '</b></div>').join('');
}

/* ---------------------------- Hintergrund ---------------------------- */
function initBG() {
  const cv = $('#bg'), ctx = cv.getContext('2d');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let pts = [];
  const resize = () => {
    cv.width = innerWidth; cv.height = innerHeight;
    const n = Math.min(70, Math.floor(innerWidth / 26));
    pts = Array.from({ length: n }, () => ({
      x: Math.random() * cv.width, y: Math.random() * cv.height,
      vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
    }));
  };
  resize(); addEventListener('resize', resize);
  (function tick() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > cv.width) p.vx *= -1;
      if (p.y < 0 || p.y > cv.height) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.3, 0, 7);
      ctx.fillStyle = 'rgba(140,160,255,.5)'; ctx.fill();
    }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = dx * dx + dy * dy;
      if (d < 130 * 130) {
        ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y);
        ctx.strokeStyle = 'rgba(120,140,255,' + (0.14 * (1 - d / (130 * 130))).toFixed(3) + ')'; ctx.stroke();
      }
    }
    requestAnimationFrame(tick);
  })();
}

/* ---------------------------- Login ---------------------------- */
function renderLogin(err) {
  stopTimers();
  app.innerHTML =
    '<div class="login-wrap"><form class="login" id="loginForm">' +
    '<span class="logo">⚓</span>' +
    '<h1>Web<b style="background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent">Hafen</b></h1>' +
    '<p>Dein Hafen für eigene Websites</p>' +
    '<input type="password" id="pw" placeholder="Passwort" autofocus autocomplete="current-password">' +
    '<button class="btn" type="submit">Anlegen ⚓</button>' +
    '<div class="err">' + esc(err || '') + '</div>' +
    '</form></div>';
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', json: { password: $('#pw').value } });
      location.hash = '#/'; boot();
    } catch (ex) { renderLogin(ex.message); }
  });
}

/* ---------------------------- Layout ---------------------------- */
function shell(active, inner) {
  const nav = [['#/', 'Übersicht'], ['#/system', 'System']];
  return '<div class="topbar">' +
    '<div class="brand"><span class="a">⚓</span>Web<b>Hafen</b></div>' +
    '<nav class="topnav">' + nav.map(([h, l]) =>
      '<a href="' + h + '" class="' + (active === h ? 'on' : '') + '">' + l + '</a>').join('') + '</nav>' +
    '<button class="btn sm" id="newSiteBtn">＋ Neue Website</button>' +
    '<button class="btn ghost sm" id="logoutBtn">Abmelden</button>' +
    '</div>' + inner;
}
function bindShell() {
  const nb = $('#newSiteBtn'); if (nb) nb.addEventListener('click', openNewSiteModal);
  const lb = $('#logoutBtn'); if (lb) lb.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    renderLogin();
  });
}

/* ---------------------------- Übersicht ---------------------------- */
async function renderOverview() {
  stopTimers();
  OVERVIEW = await api('/api/overview');
  SITES = OVERVIEW.sites;
  const s = OVERVIEW.system;
  const totPV = SITES.reduce((a, x) => a + x.today.pv, 0);
  const totVis = SITES.reduce((a, x) => a + x.today.visitors, 0);
  const totLive = SITES.reduce((a, x) => a + x.today.live, 0);

  const cards = SITES.length ? SITES.map((x, i) =>
    '<div class="site-card rise d' + (i % 3 + 1) + (x.enabled ? '' : ' off') + '" data-tilt>' +
    '<div class="glowbar"></div>' +
    '<h3>' + (x.type === 'php' ? '🐘' : '📄') + ' ' + esc(x.name) + '</h3>' +
    '<div class="meta">' +
    '<span class="tag ' + (x.enabled ? 'ok' : 'off') + '">' + (x.enabled ? '● online' : '⏸ pausiert') + '</span>' +
    '<span class="tag ' + x.type + '">' + (x.type === 'php' ? 'PHP' : 'Statisch') + '</span>' +
    '<span class="tag">Port ' + x.port + '</span>' +
    (x.pathAlias ? '<span class="tag">/s/' + esc(x.slug) + '/</span>' : '') +
    '</div>' +
    '<div class="stats">' +
    '<span>Heute <b>' + fmtNum(x.today.pv) + '</b> Aufrufe</span>' +
    '<span><b>' + fmtNum(x.today.visitors) + '</b> Besucher</span>' +
    '<span style="color:var(--ok)"><b>' + x.today.live + '</b> live</span>' +
    '</div>' +
    '<div class="acts">' +
    '<a class="btn sm" href="#/site/' + x.slug + '">📊 Dashboard</a>' +
    '<a class="btn ghost sm" href="' + siteURL(x) + '" target="_blank">↗ Öffnen</a>' +
    '<a class="btn ghost sm" href="#/site/' + x.slug + '/files">🗂 Dateien</a>' +
    '<a class="btn ghost sm" href="#/site/' + x.slug + '/settings">⚙</a>' +
    '</div></div>').join('')
    : '<div class="empty panel"><span class="big">⚓</span><h3>Noch keine Website an Bord</h3>' +
      '<p class="mt">Leg mit „＋ Neue Website" los oder lade eine ZIP hoch.</p></div>';

  app.innerHTML = shell('#/',
    '<div class="page-head rise"><div><span class="eyebrow">Flotte</span>' +
    '<h1>Deine Websites</h1><div class="sub">Alles auf einen Blick — Hosting, Analytics und Verwaltung.</div></div></div>' +
    '<div class="kpis rise d1">' +
    '<div class="kpi"><span class="ic">🌐</span><div class="n" data-count="' + SITES.length + '">0</div><div class="l">Websites</div></div>' +
    '<div class="kpi"><span class="ic">👁</span><div class="n" data-count="' + totPV + '">0</div><div class="l">Aufrufe heute</div></div>' +
    '<div class="kpi"><span class="ic">👥</span><div class="n" data-count="' + totVis + '">0</div><div class="l">Besucher heute</div></div>' +
    '<div class="kpi live"><span class="ic"><span class="pulse"></span></span><div class="n" data-count="' + totLive + '">0</div><div class="l">Gerade online</div></div>' +
    '<div class="kpi"><span class="ic">💾</span><div class="n">' + (s.disk ? fmtBytes(s.disk.free) : '–') + '</div><div class="l">Speicher frei</div></div>' +
    '</div>' +
    '<div class="sites">' + cards + '</div>');
  bindShell(); animateCounters(); attachTilt();
}

/* ---------------------------- System ---------------------------- */
async function renderSystem() {
  stopTimers();
  OVERVIEW = await api('/api/overview');
  const s = OVERVIEW.system;
  const cf = await api('/api/caddyfile');
  const up = Math.floor(s.uptime);
  const uptime = Math.floor(up / 3600) + ' h ' + Math.floor(up % 3600 / 60) + ' min';
  app.innerHTML = shell('#/system',
    '<div class="page-head rise"><div><span class="eyebrow">Maschinenraum</span><h1>System</h1>' +
    '<div class="sub">Ports, Webserver-Konfiguration und Status.</div></div>' +
    '<button class="btn ghost sm" id="reloadCaddy">🔄 Webserver neu laden</button></div>' +
    '<div class="grid2">' +
    '<div class="panel rise d1"><h3>🧭 Ports</h3>' +
    '<p class="muted mt" style="font-size:.88rem">Verwaltung läuft auf Port <b style="color:var(--a1)">' + s.ports.ui + '</b>. ' +
    'Website-Bereich: ' + s.ports.start + '–' + s.ports.end + ' <span class="muted">(änderbar in der .env-Datei)</span></p>' +
    '<div class="ports">' +
    s.ports.used.map(u => '<span class="port used" title="' + esc(u.slug) + '">' + u.port + ' · ' + esc(u.slug) + '</span>').join('') +
    s.ports.free.map(p => '<span class="port free">' + p + '</span>').join('') +
    '</div></div>' +
    '<div class="panel rise d2"><h3>💡 Status</h3><div class="mt" style="display:grid;gap:10px;font-size:.9rem">' +
    '<div>⏱ Manager-Laufzeit: <b>' + uptime + '</b></div>' +
    '<div>💾 Speicher: <b>' + (s.disk ? fmtBytes(s.disk.free) + ' frei von ' + fmtBytes(s.disk.total) : '–') + '</b></div>' +
    '<div>🟢 Node: <b>' + esc(s.node) + '</b></div>' +
    '</div></div></div>' +
    '<div class="panel rise d3 mt"><h3>📜 Caddy-Konfiguration <span class="muted" style="font-size:.8rem">(automatisch erzeugt)</span></h3>' +
    '<pre class="cfg mt">' + esc(cf.content) + '</pre></div>');
  bindShell();
  $('#reloadCaddy').addEventListener('click', async () => {
    try { await api('/api/caddy/reload', { method: 'POST' }); toast('Webserver neu geladen ✓', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------------------------- Site-Detail ---------------------------- */
function siteShellHead(site, tab) {
  const tabs = [['dash', '📊 Dashboard'], ['files', '🗂 Dateien'], ['settings', '⚙ Einstellungen']];
  return '<div class="page-head rise"><div><span class="eyebrow">' + (site.type === 'php' ? 'PHP-Website' : 'Statische Website') + '</span>' +
    '<h1>' + esc(site.name) + '</h1>' +
    '<div class="sub">' + siteURL(site) + (site.pathAlias ? ' · /s/' + esc(site.slug) + '/' : '') + '</div></div>' +
    '<div style="display:flex;gap:8px"><a class="btn sm" href="' + siteURL(site) + '" target="_blank">↗ Website öffnen</a>' +
    '<a class="btn ghost sm" href="#/">← Zur Flotte</a></div></div>' +
    '<div class="tabs rise">' + tabs.map(([k, l]) =>
      '<button class="' + (tab === k ? 'on' : '') + '" data-tab="' + k + '">' + l + '</button>').join('') + '</div>';
}
function bindSiteTabs(site) {
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
    location.hash = '#/site/' + site.slug + (b.dataset.tab === 'dash' ? '' : '/' + b.dataset.tab);
  }));
}

/* ----- Dashboard ----- */
async function renderSiteDash(site, days) {
  stopTimers();
  days = days || 30;
  const st = await api('/api/sites/' + site.slug + '/stats?days=' + days);
  const today = st.days[st.days.length - 1] || { pv: 0, visitors: 0, durAvg: 0 };
  const sumPV = st.days.reduce((a, d) => a + d.pv, 0);
  const sumBytes = st.days.reduce((a, d) => a + d.bytes, 0);
  const sumErr = st.days.reduce((a, d) => a + d.err, 0);
  const statusColors = { '2xx': '#34d399', '3xx': '#22d3ee', '4xx': '#fbbf24', '5xx': '#f87171' };
  const devColors = { desktop: '#818cf8', mobile: '#22d3ee', tablet: '#c084fc', bot: '#64748b' };
  const devNames = { desktop: 'Desktop', mobile: 'Handy', tablet: 'Tablet', bot: 'Bots' };

  app.innerHTML = shell(null, siteShellHead(site, 'dash') +
    '<div class="kpis rise d1">' +
    '<div class="kpi live"><span class="ic"><span class="pulse"></span></span><div class="n" id="liveN" data-count="' + st.liveCount + '">0</div><div class="l">Gerade online (5 min)</div></div>' +
    '<div class="kpi"><span class="ic">👁</span><div class="n" data-count="' + today.pv + '">0</div><div class="l">Aufrufe heute</div></div>' +
    '<div class="kpi"><span class="ic">👥</span><div class="n" data-count="' + today.visitors + '">0</div><div class="l">Besucher heute</div></div>' +
    '<div class="kpi"><span class="ic">📈</span><div class="n" data-count="' + sumPV + '">0</div><div class="l">Aufrufe (' + days + ' Tage)</div></div>' +
    '<div class="kpi"><span class="ic">⚡</span><div class="n">' + fmtMs(today.durAvg) + '</div><div class="l">Ø Antwortzeit heute</div></div>' +
    '<div class="kpi"><span class="ic">📦</span><div class="n">' + fmtBytes(sumBytes) + '</div><div class="l">Traffic (' + days + ' Tage)</div></div>' +
    '</div>' +
    '<div class="panel rise d1"><div class="chart-title"><h3>Besucherverlauf</h3>' +
    '<div style="display:flex;gap:12px;align-items:center"><div class="legend">' +
    '<span><i style="background:linear-gradient(90deg,#22d3ee,#c084fc)"></i>Aufrufe</span>' +
    '<span><i style="background:#34d399"></i>Besucher</span></div>' +
    '<select id="rangeSel"><option value="7"' + (days === 7 ? ' selected' : '') + '>7 Tage</option>' +
    '<option value="30"' + (days === 30 ? ' selected' : '') + '>30 Tage</option>' +
    '<option value="90"' + (days === 90 ? ' selected' : '') + '>90 Tage</option></select></div></div>' +
    '<div class="chart-wrap">' + areaChart(st.days) + '</div></div>' +
    '<div class="grid3 mt">' +
    '<div class="panel rise d2"><div class="chart-title"><h3>Uhrzeiten (' + days + ' Tage)</h3></div>' +
    '<div class="chart-wrap">' + hourBars(st.hours) + '</div></div>' +
    '<div class="panel rise d2"><div class="chart-title"><h3>Status-Codes</h3></div>' +
    donut(Object.keys(statusColors).map(k => ({ label: k, value: st.status[k] || 0, color: statusColors[k] }))) +
    (sumErr ? '<p class="muted mt" style="font-size:.83rem">⚠️ ' + fmtNum(sumErr) + ' Fehler-Antworten im Zeitraum</p>' : '') +
    '</div></div>' +
    '<div class="grid2 mt">' +
    '<div class="panel rise d2"><div class="chart-title"><h3>Meistbesuchte Seiten</h3></div>' + listBars(st.topPages) + '</div>' +
    '<div class="panel rise d3"><div class="chart-title"><h3>Woher die Besucher kommen</h3></div>' +
    (st.topRefs.length ? listBars(st.topRefs) : '<p class="muted" style="padding:14px 0">Bisher nur Direktaufrufe (kein Referrer).</p>') +
    '</div></div>' +
    '<div class="grid2 mt">' +
    '<div class="panel rise d3"><div class="chart-title"><h3>Geräte</h3></div>' +
    donut(Object.keys(devColors).map(k => ({ label: devNames[k], value: st.devices[k] || 0, color: devColors[k] }))) + '</div>' +
    '<div class="panel rise d3"><div class="chart-title"><h3><span class="pulse"></span>Live-Aktivität</h3></div>' +
    '<div class="feed" id="liveFeed"><p class="muted" style="padding:12px 0">Lade …</p></div></div>' +
    '</div>');
  bindShell(); bindSiteTabs(site); animateCounters();
  $('#rangeSel').addEventListener('change', e => renderSiteDash(site, +e.target.value));

  const feed = async () => {
    try {
      const lv = await api('/api/sites/' + site.slug + '/live');
      const ln = $('#liveN'); if (ln) ln.textContent = fmtNum(lv.liveCount);
      const el = $('#liveFeed'); if (!el) return;
      el.innerHTML = lv.events.length ? lv.events.slice(0, 40).map(e => {
        const cls = e.status >= 500 ? 'err' : e.status >= 400 ? 'warn' : 'ok';
        const t = new Date(e.t).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return '<div class="row"><span class="t">' + t + '</span>' +
          '<span class="u" title="' + esc(e.uri) + '">' + (e.page ? '📄 ' : '· ') + esc(e.uri) + '</span>' +
          (e.ref ? '<span class="muted" style="font-size:.76rem">von ' + esc(e.ref) + '</span>' : '') +
          '<span class="s ' + cls + '">' + e.status + '</span></div>';
      }).join('') : '<p class="muted" style="padding:12px 0">Noch keine Aktivität — öffne die Website einmal! 😉</p>';
    } catch (_) {}
  };
  feed();
  liveTimer = setInterval(feed, 5000);
}

/* ----- Dateimanager ----- */
async function renderSiteFiles(site, dir) {
  stopTimers();
  dir = dir || '';
  let data;
  try { data = await api('/api/sites/' + site.slug + '/files?dir=' + encodeURIComponent(dir)); }
  catch (e) { toast(e.message, 'err'); data = { entries: [] }; }
  const parts = dir.split('/').filter(Boolean);
  const crumbs = ['<a href="javascript:void 0" data-dir="">🏠 ' + esc(site.slug) + '</a>'].concat(
    parts.map((p, i) => '<span class="muted">/</span><a href="javascript:void 0" data-dir="' +
      esc(parts.slice(0, i + 1).join('/')) + '">' + esc(p) + '</a>')).join('');

  const rows = data.entries.map(e => {
    const p = (dir ? dir + '/' : '') + e.name;
    return '<tr>' +
      '<td><span class="fname" data-open="' + esc(p) + '" data-dir-flag="' + (e.dir ? 1 : 0) + '">' +
      (e.dir ? '📁' : fileIcon(e.name)) + ' ' + esc(e.name) + '</span></td>' +
      '<td class="muted">' + (e.dir ? '–' : fmtBytes(e.size)) + '</td>' +
      '<td class="muted">' + (e.mtime ? new Date(e.mtime).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' }) : '') + '</td>' +
      '<td><div class="facts">' +
      (!e.dir ? '<button class="ibtn" title="Bearbeiten" data-edit="' + esc(p) + '">✏️</button>' +
        '<a class="ibtn" title="Herunterladen" href="/api/sites/' + site.slug + '/file?path=' + encodeURIComponent(p) + '&download=1">⬇️</a>' : '') +
      '<button class="ibtn" title="Umbenennen" data-ren="' + esc(p) + '">🔤</button>' +
      '<button class="ibtn" title="Löschen" data-del="' + esc(p) + '">🗑️</button>' +
      '</div></td></tr>';
  }).join('');

  app.innerHTML = shell(null, siteShellHead(site, 'files') +
    '<div class="panel rise d1">' +
    '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">' +
    '<div class="crumbs" id="crumbs" style="margin:0">' + crumbs + '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn sm" id="upBtn">⬆️ Dateien hochladen</button>' +
    '<button class="btn ghost sm" id="zipBtn">📦 ZIP hochladen</button>' +
    '<button class="btn ghost sm" id="newFileBtn">＋ Datei</button>' +
    '<button class="btn ghost sm" id="newDirBtn">＋ Ordner</button>' +
    '<a class="btn ghost sm" href="/api/sites/' + site.slug + '/export">💾 Als ZIP sichern</a>' +
    '</div></div>' +
    '<table class="ftable"><thead><tr><th>Name</th><th>Größe</th><th>Geändert</th><th style="text-align:right">Aktionen</th></tr></thead>' +
    '<tbody>' + (rows || '<tr><td colspan="4" class="muted" style="padding:22px">Leerer Ordner</td></tr>') + '</tbody></table>' +
    '<div class="dropzone" id="drop">📥 Dateien einfach hierher ziehen — ZIPs werden auf Wunsch automatisch entpackt</div>' +
    '<input type="file" id="fileInput" multiple hidden><input type="file" id="zipInput" accept=".zip" hidden>' +
    '</div>');
  bindShell(); bindSiteTabs(site);

  const reload = () => renderSiteFiles(site, dir);
  $('#crumbs').querySelectorAll('[data-dir]').forEach(a =>
    a.addEventListener('click', () => renderSiteFiles(site, a.dataset.dir)));

  document.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => {
    if (el.dataset.dirFlag === '1') renderSiteFiles(site, el.dataset.open);
    else openEditor(site, el.dataset.open, reload);
  }));
  document.querySelectorAll('[data-edit]').forEach(el =>
    el.addEventListener('click', () => openEditor(site, el.dataset.edit, reload)));
  document.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', async () => {
    if (!confirm('„' + el.dataset.del + '" wirklich löschen?')) return;
    try { await api('/api/sites/' + site.slug + '/fileop', { method: 'POST', json: { op: 'delete', path: el.dataset.del } }); toast('Gelöscht ✓', 'ok'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  }));
  document.querySelectorAll('[data-ren]').forEach(el => el.addEventListener('click', async () => {
    const old = el.dataset.ren;
    const nn = prompt('Neuer Name:', old.split('/').pop());
    if (!nn || nn === old.split('/').pop()) return;
    const to = (dir ? dir + '/' : '') + nn;
    try { await api('/api/sites/' + site.slug + '/fileop', { method: 'POST', json: { op: 'rename', path: old, to } }); reload(); }
    catch (e) { toast(e.message, 'err'); }
  }));
  $('#newDirBtn').addEventListener('click', async () => {
    const n = prompt('Name des neuen Ordners:'); if (!n) return;
    try { await api('/api/sites/' + site.slug + '/fileop', { method: 'POST', json: { op: 'mkdir', path: (dir ? dir + '/' : '') + n } }); reload(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#newFileBtn').addEventListener('click', async () => {
    const n = prompt('Name der neuen Datei (z. B. seite.html):'); if (!n) return;
    try {
      await api('/api/sites/' + site.slug + '/fileop', { method: 'POST', json: { op: 'newfile', path: (dir ? dir + '/' : '') + n } });
      openEditor(site, (dir ? dir + '/' : '') + n, reload);
    } catch (e) { toast(e.message, 'err'); }
  });

  const uploadFiles = async files => {
    for (const f of files) {
      if (/\.zip$/i.test(f.name) && confirm('„' + f.name + '" ist eine ZIP.\n\nOK = entpacken (Inhalt landet in diesem Ordner)\nAbbrechen = als Datei speichern')) {
        const clean = confirm('Ordner vorher leeren? (OK = ja, alte Dateien werden gelöscht)');
        toast('Entpacke ' + f.name + ' …');
        try {
          await fetch('/api/sites/' + site.slug + '/upload?extract=1&clean=' + (clean ? 1 : 0) + '&dir=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(f.name),
            { method: 'PUT', headers: { 'X-WH': '1' }, body: f }).then(r => r.json()).then(d => { if (d.ok === false) throw new Error(d.error); });
          toast(f.name + ' entpackt ✓', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      } else {
        toast('Lade ' + f.name + ' hoch …');
        try {
          await fetch('/api/sites/' + site.slug + '/upload?dir=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(f.name),
            { method: 'PUT', headers: { 'X-WH': '1' }, body: f }).then(r => r.json()).then(d => { if (d.ok === false) throw new Error(d.error); });
          toast(f.name + ' ✓', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      }
    }
    reload();
  };
  $('#upBtn').addEventListener('click', () => $('#fileInput').click());
  $('#zipBtn').addEventListener('click', () => $('#zipInput').click());
  $('#fileInput').addEventListener('change', e => uploadFiles([...e.target.files]));
  $('#zipInput').addEventListener('change', e => uploadFiles([...e.target.files]));
  const dz = $('#drop');
  dz.addEventListener('click', () => $('#fileInput').click());
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('hot'); }));
  dz.addEventListener('drop', e => uploadFiles([...e.dataTransfer.files]));
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ({ html: '🌐', htm: '🌐', php: '🐘', css: '🎨', js: '⚙️', json: '🧾', md: '📝',
    png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼', ico: '🖼',
    zip: '📦', pdf: '📕', mp4: '🎬', webm: '🎬', mp3: '🎵', woff: '🔤', woff2: '🔤', txt: '📄' })[ext] || '📄';
}
function openEditor(site, filePath, onSave) {
  const editable = /\.(html?|css|js|json|php|md|txt|xml|svg|ini|htaccess|yml|yaml|csv)$/i.test(filePath) || !/\./.test(filePath.split('/').pop());
  if (!editable) { toast('Diese Datei ist keine Textdatei — bitte herunterladen.', 'err'); return; }
  api('/api/sites/' + site.slug + '/file?path=' + encodeURIComponent(filePath))
    .then(d => {
      modal('<h3>✏️ ' + esc(filePath) + '</h3>',
        '<textarea class="code" id="edArea" spellcheck="false"></textarea>',
        '<button class="btn ghost" data-close>Abbrechen</button><button class="btn" id="edSave">💾 Speichern</button>', true);
      $('#edArea').value = d.content;
      $('#edSave').addEventListener('click', async () => {
        try {
          await fetch('/api/sites/' + site.slug + '/file?path=' + encodeURIComponent(filePath),
            { method: 'PUT', headers: { 'X-WH': '1' }, body: $('#edArea').value })
            .then(r => r.json()).then(x => { if (x.ok === false) throw new Error(x.error); });
          toast('Gespeichert ✓', 'ok'); closeModal(); onSave && onSave();
        } catch (e) { toast(e.message, 'err'); }
      });
    })
    .catch(e => toast(e.message, 'err'));
}

/* ----- Einstellungen ----- */
async function renderSiteSettings(site) {
  stopTimers();
  OVERVIEW = OVERVIEW || await api('/api/overview');
  const freePorts = [site.port].concat(OVERVIEW.system ? OVERVIEW.system.ports.free : []);
  app.innerHTML = shell(null, siteShellHead(site, 'settings') +
    '<div class="grid2">' +
    '<div class="panel rise d1"><h3>⚙ Grundeinstellungen</h3><div class="mt" style="display:grid;gap:16px">' +
    '<label class="fld">Name<input id="sName" value="' + esc(site.name) + '"></label>' +
    '<label class="fld">Typ<select id="sType">' +
    '<option value="static"' + (site.type === 'static' ? ' selected' : '') + '>Statisch (HTML/CSS/JS)</option>' +
    '<option value="php"' + (site.type === 'php' ? ' selected' : '') + '>PHP</option></select></label>' +
    '<label class="fld">Port<select id="sPort">' +
    freePorts.map(p => '<option value="' + p + '"' + (p === site.port ? ' selected' : '') + '>' + p + (p === site.port ? ' (aktuell)' : '') + '</option>').join('') +
    '</select></label>' +
    '<label class="fld" style="grid-template-columns:1fr auto;display:grid;align-items:center">Website aktiv' +
    '<span class="switch"><input type="checkbox" id="sEnabled"' + (site.enabled ? ' checked' : '') + '><span></span></span></label>' +
    '<label class="fld" style="grid-template-columns:1fr auto;display:grid;align-items:center">Zusätzlich unter /s/' + esc(site.slug) + '/ (nur statisch)' +
    '<span class="switch"><input type="checkbox" id="sAlias"' + (site.pathAlias ? ' checked' : '') + '><span></span></span></label>' +
    '<label class="fld">Notiz<input id="sNote" value="' + esc(site.note || '') + '" placeholder="optional"></label>' +
    '</div></div>' +
    '<div class="panel rise d2"><h3>🛡 Geschützte Ordner</h3>' +
    '<p class="muted mt" style="font-size:.86rem;line-height:1.55">Diese Pfade sind von außen gesperrt (403) — z. B. Datenbank- oder Konfigurations-Ordner. Ein Pfad pro Zeile.</p>' +
    '<textarea id="sProt" class="mt" style="width:100%;min-height:130px;font-family:monospace">' +
    esc((site.protected || []).join('\n')) + '</textarea>' +
    '<h3 class="mt">🧨 Gefahrenzone</h3>' +
    '<div class="mt" style="display:flex;gap:10px;flex-wrap:wrap">' +
    '<a class="btn ghost sm" href="/api/sites/' + site.slug + '/export">💾 Backup als ZIP</a>' +
    '<button class="btn danger sm" id="delBtn">🗑 Website löschen</button></div>' +
    '</div></div>' +
    '<div class="mt rise d3" style="display:flex;justify-content:flex-end">' +
    '<button class="btn" id="saveBtn">💾 Einstellungen speichern</button></div>');
  bindShell(); bindSiteTabs(site);

  $('#saveBtn').addEventListener('click', async () => {
    try {
      const d = await api('/api/sites/' + site.slug, { method: 'PATCH', json: {
        name: $('#sName').value, type: $('#sType').value, port: +$('#sPort').value,
        enabled: $('#sEnabled').checked, pathAlias: $('#sAlias').checked,
        note: $('#sNote').value,
        protected: $('#sProt').value.split('\n').map(x => x.trim()).filter(Boolean),
      } });
      toast('Gespeichert ✓', 'ok');
      OVERVIEW = null;
      renderSiteSettings(d.site);
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#delBtn').addEventListener('click', async () => {
    if (!confirm('„' + site.name + '" wirklich löschen?')) return;
    const withFiles = confirm('Auch alle DATEIEN und Statistiken löschen?\n\nOK = ja, alles weg\nAbbrechen = nur aus der Verwaltung entfernen (Dateien bleiben auf der Platte)');
    try {
      await api('/api/sites/' + site.slug + '?files=' + (withFiles ? 1 : 0), { method: 'DELETE' });
      toast('Website gelöscht', 'ok'); location.hash = '#/';
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------------------------- Neue Website ---------------------------- */
async function openNewSiteModal() {
  OVERVIEW = OVERVIEW || await api('/api/overview').catch(() => null);
  const free = OVERVIEW && OVERVIEW.system ? OVERVIEW.system.ports.free : [];
  modal('<h3>＋ Neue Website</h3>',
    '<label class="fld">Name<input id="nName" placeholder="z. B. Mein Portfolio" autofocus></label>' +
    '<label class="fld">Typ<select id="nType">' +
    '<option value="static">Statisch — HTML/CSS/JS (auch GitHub-Pages-Projekte wie MFU-TEST)</option>' +
    '<option value="php">PHP — z. B. wie die Montrigor-Website</option></select></label>' +
    '<label class="fld">Port<select id="nPort"><option value="">Automatisch (nächster freier)</option>' +
    free.map(p => '<option value="' + p + '">' + p + '</option>').join('') + '</select></label>' +
    '<p class="muted" style="font-size:.84rem;line-height:1.5">Die Website startet mit einer schönen Platzhalter-Seite. ' +
    'Danach einfach im Dateimanager eine ZIP hochladen oder Dateien reinziehen.</p>',
    '<button class="btn ghost" data-close>Abbrechen</button><button class="btn" id="nCreate">⚓ Erstellen</button>');
  $('#nCreate').addEventListener('click', async () => {
    try {
      const d = await api('/api/sites', { method: 'POST', json: {
        name: $('#nName').value, type: $('#nType').value, port: $('#nPort').value || undefined } });
      closeModal(); toast('Website „' + d.site.name + '" läuft auf Port ' + d.site.port + ' ✓', 'ok');
      location.hash = '#/site/' + d.site.slug + '/files';
      route();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------------------------- Modal ---------------------------- */
function modal(head, body, foot, wide) {
  closeModal();
  const el = document.createElement('div');
  el.className = 'modal'; el.id = 'modal';
  el.innerHTML = '<div class="back" data-close></div><div class="box' + (wide ? ' wide' : '') + '">' +
    '<div class="head">' + head + '<button class="ibtn" data-close style="font-size:1.2rem">✕</button></div>' +
    '<div class="body">' + body + '</div><div class="foot">' + foot + '</div></div>';
  document.body.appendChild(el);
  el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() { const m = $('#modal'); if (m) m.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------------------------- Router ---------------------------- */
async function route() {
  const h = location.hash || '#/';
  try {
    const m = /^#\/site\/([a-z0-9-]+)(?:\/(files|settings))?/.exec(h);
    if (m) {
      const d = await api('/api/sites/' + m[1]);
      if (m[2] === 'files') return renderSiteFiles(d.site);
      if (m[2] === 'settings') return renderSiteSettings(d.site);
      return renderSiteDash(d.site);
    }
    if (h.startsWith('#/system')) return renderSystem();
    return renderOverview();
  } catch (e) {
    if (e.message !== 'Nicht angemeldet') { toast(e.message, 'err'); }
  }
}
async function boot() {
  try {
    const me = await api('/api/me');
    if (!me.authed) return renderLogin();
    route();
  } catch (_) { renderLogin(); }
}
addEventListener('hashchange', route);
initBG();
boot();
