'use strict';
/* ============================================================================
 *  WebHafen — Manager-Backend
 *  ---------------------------------------------------------------------------
 *  Reines Node.js (keine Abhängigkeiten). Aufgaben:
 *   - Verwaltungs-API + Auslieferung der UI
 *   - Sites anlegen / hochladen (ZIP) / Dateimanager
 *   - Portvergabe aus dem konfigurierten Bereich
 *   - Caddy-Konfiguration erzeugen und neu laden
 *   - Analytics: Caddy-Access-Logs (JSON) einlesen und aggregieren
 * ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/* ----------------------------- Konfiguration ----------------------------- */
const CFG = {
  uiPort:      parseInt(process.env.PORT_UI || '8010', 10),
  portStart:   parseInt(process.env.PORT_SITES_START || '8011', 10),
  portEnd:     parseInt(process.env.PORT_SITES_END || '8043', 10),
  password:    process.env.ADMIN_PASSWORD || 'BitteAendern123!',
  secret:      process.env.APP_SECRET || 'webhafen_dev_secret',
  dataDir:     process.env.DATA_DIR || '/data',
  seedDir:     process.env.SEED_DIR || '/seed',
  managerPort: parseInt(process.env.MANAGER_PORT || '3210', 10),
  uiDir:       path.join(__dirname, 'ui'),
};
const SITES_JSON = path.join(CFG.dataDir, 'sites.json');
const CADDYFILE  = path.join(CFG.dataDir, 'caddy', 'Caddyfile');
const SESSION_HOURS = 24 * 7;

const sitePublic = slug => path.join(CFG.dataDir, 'sites', slug, 'public');
const logPath    = slug => path.join(CFG.dataDir, 'logs', slug + '.log');
const anaDir     = slug => path.join(CFG.dataDir, 'analytics', slug);

/* ------------------------------- Hilfsfunktionen -------------------------- */
function ensureDirs() {
  for (const d of ['sites', 'logs', 'analytics', 'caddy', 'tmp'])
    fs.mkdirSync(path.join(CFG.dataDir, d), { recursive: true });
}
function slugify(name) {
  return String(name).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}
function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
function sh(cmd, args, opts, cb) {
  execFile(cmd, args, Object.assign({ timeout: 120000 }, opts), (err, stdout, stderr) =>
    cb && cb(err ? (String(stderr || '').trim() || String(err.message)) : null, String(stdout || '')));
}
function localDay(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ------------------------------- Site-Store ------------------------------- */
let store = { sites: [] };
function loadStore() {
  try { store = JSON.parse(fs.readFileSync(SITES_JSON, 'utf8')); } catch (_) { store = { sites: [] }; }
  if (!Array.isArray(store.sites)) store.sites = [];
}
function saveStore() { atomicWrite(SITES_JSON, JSON.stringify(store, null, 2)); }
function findSite(slug) { return store.sites.find(s => s.slug === slug); }
function usedPorts() {
  const used = new Set([CFG.uiPort]);
  store.sites.forEach(s => s.port && used.add(s.port));
  return used;
}
function nextFreePort() {
  const used = usedPorts();
  for (let p = CFG.portStart; p <= CFG.portEnd; p++) if (!used.has(p)) return p;
  return 0;
}

/* --------------------------- Montrigor-Auto-Import ------------------------ */
function seedImport() {
  const src = path.join(CFG.seedDir, 'montrigor-site');
  if (!fs.existsSync(src) || findSite('montrigor')) return;
  const excluded = ['php', '.git', 'node_modules', 'INSTALLIEREN.bat', 'START-LOKAL.bat',
    'setup-php.ps1', 'Dockerfile', 'docker-compose.yml', '.dockerignore'];
  const dest = sitePublic('montrigor');
  console.log('[seed] Importiere Montrigor-Website …');
  try {
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (p) => {
        const rel = path.relative(src, p);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        return !excluded.includes(top);
      },
    });
    const port = nextFreePort();
    store.sites.push({
      slug: 'montrigor', name: 'Montrigor', type: 'php', port,
      enabled: true, pathAlias: false,
      protected: ['/data', '/includes', '/sql'],
      createdAt: Date.now(), note: 'Automatisch importiert',
    });
    saveStore();
    sh('chown', ['-R', 'www-data:www-data', path.dirname(dest)], {}, () => {});
    console.log('[seed] Montrigor importiert auf Port ' + port);
  } catch (e) { console.error('[seed] Import fehlgeschlagen:', e.message); }
}

/* --------------------------- Caddy-Konfiguration -------------------------- */
function buildCaddyfile() {
  let out = '# Automatisch von WebHafen erzeugt — nicht von Hand bearbeiten.\n';
  out += '{\n  admin 127.0.0.1:2019\n  auto_https off\n}\n\n';

  /* UI-Port: Verwaltung + optionale Pfad-Adressen /s/<slug>/ für statische Sites */
  out += ':' + CFG.uiPort + ' {\n  encode gzip\n';
  for (const s of store.sites) {
    if (!(s.enabled && s.pathAlias && s.type === 'static')) continue;
    out += '  redir /s/' + s.slug + ' /s/' + s.slug + '/ 301\n';
    out += '  handle_path /s/' + s.slug + '/* {\n'
         + '    root * ' + sitePublic(s.slug) + '\n'
         + '    file_server\n  }\n';
  }
  out += '  handle {\n    reverse_proxy 127.0.0.1:' + CFG.managerPort + '\n  }\n}\n\n';

  /* Eigener Port pro Site */
  for (const s of store.sites) {
    if (!s.port) continue;
    out += ':' + s.port + ' {\n  encode gzip\n';
    out += '  log {\n    output file ' + logPath(s.slug)
         + ' {\n      roll_size 10MiB\n      roll_keep 3\n    }\n    format json\n  }\n';
    if (!s.enabled) {
      out += '  respond "WebHafen: Diese Website ist gerade pausiert." 503\n}\n\n';
      continue;
    }
    out += '  root * ' + sitePublic(s.slug) + '\n';
    const prot = (s.protected || []).map(p => '/' + String(p).replace(/^\/+|\/+$/g, '') + '/*');
    if (prot.length) out += '  @blocked path ' + prot.join(' ') + '\n  respond @blocked 403\n';
    out += '  @hidden path_regexp (^|/)\\.\n  respond @hidden 403\n';
    if (s.type === 'php') out += '  php_fastcgi 127.0.0.1:9000\n';
    out += '  file_server\n}\n\n';
  }
  return out;
}
function writeCaddyfile() { atomicWrite(CADDYFILE, buildCaddyfile()); }
function applyCaddy(cb) {
  writeCaddyfile();
  const env = Object.assign({}, process.env,
    { XDG_DATA_HOME: '/data/caddy/data', XDG_CONFIG_HOME: '/data/caddy/config' });
  sh('caddy', ['reload', '--config', CADDYFILE, '--adapter', 'caddyfile'], { env }, (err) => {
    if (err) console.error('[caddy] Reload-Fehler:', err);
    cb && cb(err);
  });
}

/* -------------------------------- Analytics ------------------------------- */
/* Liest die JSON-Access-Logs von Caddy und aggregiert pro Site und Tag. */
const A = new Map(); // slug -> Zustand

function newAgg() {
  return { pv: 0, hits: 0, bytes: 0, durSum: 0, durCnt: 0, err: 0,
    visitors: {}, pages: {}, refs: {}, status: {},
    hours: Array(24).fill(0), devices: { desktop: 0, mobile: 0, tablet: 0, bot: 0 } };
}
function anaState(slug) {
  let st = A.get(slug);
  if (!st) {
    st = { offset: 0, buf: '', day: localDay(), agg: newAgg(), live: [], dirty: false };
    /* Heutigen Stand von der Platte weiterführen (nach Neustart) */
    try {
      const f = path.join(anaDir(slug), st.day + '.json');
      const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
      st.agg = Object.assign(newAgg(), saved.agg);
      st.offset = saved.offset || 0;
    } catch (_) {}
    A.set(slug, st);
  }
  return st;
}
function persistAgg(slug, st) {
  fs.mkdirSync(anaDir(slug), { recursive: true });
  atomicWrite(path.join(anaDir(slug), st.day + '.json'),
    JSON.stringify({ offset: st.offset, agg: st.agg }));
  st.dirty = false;
}
function isPagePath(uri) {
  const ext = path.extname(uri).toLowerCase();
  return ext === '' || ext === '.html' || ext === '.htm' || ext === '.php';
}
function refHost(ref) {
  if (!ref) return '';
  try { return new URL(ref).host; } catch (_) { return ''; }
}
function capInc(obj, key, cap) {
  if (obj[key] !== undefined || Object.keys(obj).length < (cap || 500)) obj[key] = (obj[key] || 0) + 1;
}
function handleLogLine(slug, st, obj) {
  const req = obj.request || {};
  const ts  = obj.ts ? new Date(obj.ts * 1000) : new Date();
  const day = localDay(ts);
  if (day !== st.day) { persistAgg(slug, st); st.day = day; st.agg = newAgg(); }
  const agg = st.agg;
  const headers = req.headers || {};
  const ua  = (headers['User-Agent'] || [''])[0] || '';
  const ref = (headers['Referer'] || [''])[0] || '';
  const uri = String(req.uri || '/').split('?')[0];
  const ip  = req.client_ip || req.remote_ip || req.remote_addr || '';
  const status = obj.status | 0;

  agg.hits++; agg.bytes += obj.size | 0;
  agg.durSum += (+obj.duration || 0); agg.durCnt++;
  const sk = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
  agg.status[sk] = (agg.status[sk] || 0) + 1;
  if (status >= 400) agg.err++;

  const dev = /bot|crawl|spider|slurp|curl|wget|python|go-http|monitor|scan|preview|facebookexternalhit/i.test(ua)
    ? 'bot'
    : /ipad|tablet/i.test(ua) ? 'tablet'
    : /mobile|android|iphone|ipod/i.test(ua) ? 'mobile' : 'desktop';
  agg.devices[dev]++;

  const page = (req.method === 'GET') && status < 400 && isPagePath(uri);
  if (page && dev !== 'bot') {
    agg.pv++;
    agg.hours[ts.getHours()]++;
    capInc(agg.pages, uri, 500);
    const rh = refHost(ref);
    if (rh) capInc(agg.refs, rh, 300);
    const vh = crypto.createHash('sha256').update(ip + '|' + ua + '|' + day + '|' + CFG.secret)
      .digest('hex').slice(0, 12);
    if (agg.visitors[vh] !== undefined || Object.keys(agg.visitors).length < 5000)
      agg.visitors[vh] = (agg.visitors[vh] || 0) + 1;
  }
  st.live.push({ t: ts.getTime(), uri, status, dev, ref: refHost(ref), page });
  if (st.live.length > 300) st.live.shift();
  st.dirty = true;
}
function pollLogs() {
  for (const s of store.sites) {
    const st = anaState(s.slug);
    let size = 0;
    try { size = fs.statSync(logPath(s.slug)).size; } catch (_) { continue; }
    if (size < st.offset) { st.offset = 0; st.buf = ''; }           // Log wurde rotiert
    if (size === st.offset) continue;
    let fd;
    try {
      fd = fs.openSync(logPath(s.slug), 'r');
      const len = Math.min(size - st.offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.offset);
      st.offset += len;
      const text = st.buf + buf.toString('utf8');
      const lines = text.split('\n');
      st.buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleLogLine(s.slug, st, JSON.parse(line)); } catch (_) {}
      }
    } catch (_) {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
  }
}
function statsFor(slug, days) {
  const st = anaState(slug);
  const today = localDay();
  const out = { days: [], topPages: {}, topRefs: {}, status: {}, devices: { desktop: 0, mobile: 0, tablet: 0, bot: 0 }, hours: Array(24).fill(0) };
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = localDay(d);
    let agg = null;
    if (key === today) agg = st.agg;
    else { try { agg = JSON.parse(fs.readFileSync(path.join(anaDir(slug), key + '.json'), 'utf8')).agg; } catch (_) {} }
    if (!agg) { out.days.push({ date: key, pv: 0, hits: 0, visitors: 0, bytes: 0, durAvg: 0, err: 0 }); continue; }
    out.days.push({
      date: key, pv: agg.pv, hits: agg.hits,
      visitors: Object.keys(agg.visitors || {}).length,
      bytes: agg.bytes, err: agg.err || 0,
      durAvg: agg.durCnt ? agg.durSum / agg.durCnt : 0,
    });
    for (const [k, v] of Object.entries(agg.pages || {}))  out.topPages[k] = (out.topPages[k] || 0) + v;
    for (const [k, v] of Object.entries(agg.refs || {}))   out.topRefs[k]  = (out.topRefs[k]  || 0) + v;
    for (const [k, v] of Object.entries(agg.status || {})) out.status[k]   = (out.status[k]   || 0) + v;
    for (const k of Object.keys(out.devices)) out.devices[k] += (agg.devices || {})[k] || 0;
    (agg.hours || []).forEach((v, h) => out.hours[h] += v);
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  out.topPages = top(out.topPages, 15);
  out.topRefs  = top(out.topRefs, 12);
  const now = Date.now();
  out.liveCount = st.live.filter(e => e.page && now - e.t < 5 * 60 * 1000).length;
  return out;
}

/* ------------------------------ Login/Sessions ---------------------------- */
const loginAttempts = new Map(); // ip -> [timestamps]
function makeSession() {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const sig = crypto.createHmac('sha256', CFG.secret).update('sess.' + exp).digest('hex');
  return exp + '.' + sig;
}
function checkSession(cookieHeader) {
  const m = /(?:^|;\s*)wh_sess=([^;]+)/.exec(cookieHeader || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Date.now() > +exp) return false;
  const want = crypto.createHmac('sha256', CFG.secret).update('sess.' + exp).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)); } catch (_) { return false; }
}
function rateLimited(ip) {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  loginAttempts.set(ip, arr);
  return arr.length >= 8;
}

/* ------------------------------ HTTP-Helfer ------------------------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (maxBytes || 2 * 1024 * 1024)) { reject(new Error('Zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req) {
  const b = await readBody(req, 2 * 1024 * 1024);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch (_) { return {}; }
}
function safePath(slug, rel) {
  const base = sitePublic(slug);
  const p = path.normalize(path.join(base, rel || ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Ungültiger Pfad');
  return p;
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
};

/* --------------------------- Starter-Vorlage ------------------------------ */
function starterHTML(name) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<style>
  *{margin:0;box-sizing:border-box}
  body{min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;
       background:radial-gradient(900px 500px at 50% -10%,rgba(56,130,246,.25),transparent 60%),#0a0c14;color:#eef1f8}
  .box{text-align:center;padding:40px;max-width:560px}
  h1{font-size:clamp(2rem,7vw,3.4rem);background:linear-gradient(120deg,#7dd3fc,#818cf8);
     -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  p{color:#9aa3b8;margin-top:14px;line-height:1.6}
  .tag{display:inline-block;margin-top:26px;padding:.5em 1.2em;border:1px solid rgba(255,255,255,.14);
       border-radius:99px;font-size:.85rem;color:#9aa3b8}
</style>
</head>
<body>
  <div class="box">
    <h1>${name}</h1>
    <p>Diese Website läuft — jetzt eigene Dateien über WebHafen hochladen<br>(ZIP hochladen oder Dateien im Dateimanager ablegen).</p>
    <span class="tag">⚓ gehostet mit WebHafen</span>
  </div>
</body>
</html>
`;
}

/* -------------------------------- API-Router ------------------------------ */
async function handleAPI(req, res, url) {
  const ip = req.socket.remoteAddress || '?';
  const p = url.pathname;

  /* ---- ohne Login erreichbar ---- */
  if (p === '/api/login' && req.method === 'POST') {
    if (rateLimited(ip)) return sendJSON(res, 429, { ok: false, error: 'Zu viele Versuche — bitte 10 Minuten warten.' });
    const body = await readJSONBody(req);
    const given = Buffer.from(String(body.password || ''));
    const want  = Buffer.from(CFG.password);
    const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      (loginAttempts.get(ip) || loginAttempts.set(ip, []).get(ip)).push(Date.now());
      return sendJSON(res, 401, { ok: false, error: 'Falsches Passwort.' });
    }
    res.setHeader('Set-Cookie', 'wh_sess=' + makeSession()
      + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (SESSION_HOURS * 3600));
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/me') return sendJSON(res, 200, { ok: true, authed: checkSession(req.headers.cookie) });

  /* ---- ab hier: Login nötig ---- */
  if (!checkSession(req.headers.cookie)) return sendJSON(res, 401, { ok: false, error: 'Nicht angemeldet.' });
  if (req.method !== 'GET' && req.headers['x-wh'] !== '1')
    return sendJSON(res, 403, { ok: false, error: 'CSRF-Schutz: Header fehlt.' });

  if (p === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'wh_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- Übersicht / System ---- */
  if (p === '/api/overview') {
    let disk = null;
    try { const s = fs.statfsSync(CFG.dataDir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch (_) {}
    const used = [];
    store.sites.forEach(s => s.port && used.push({ port: s.port, slug: s.slug }));
    const free = [];
    const u = usedPorts();
    for (let x = CFG.portStart; x <= CFG.portEnd; x++) if (!u.has(x)) free.push(x);
    return sendJSON(res, 200, {
      ok: true,
      sites: store.sites.map(s => {
        const st = anaState(s.slug);
        const now = Date.now();
        return Object.assign({}, s, { today: {
          pv: st.agg.pv, visitors: Object.keys(st.agg.visitors).length,
          live: st.live.filter(e => e.page && now - e.t < 5 * 60 * 1000).length,
        } });
      }),
      system: {
        uptime: process.uptime(), node: process.version, disk,
        ports: { ui: CFG.uiPort, start: CFG.portStart, end: CFG.portEnd, used, free },
      },
    });
  }
  if (p === '/api/caddyfile') return sendJSON(res, 200, { ok: true, content: buildCaddyfile() });
  if (p === '/api/caddy/reload' && req.method === 'POST')
    return applyCaddy(err => sendJSON(res, err ? 500 : 200, { ok: !err, error: err || undefined }));

  /* ---- Sites: Liste + Anlegen ---- */
  if (p === '/api/sites' && req.method === 'GET') return sendJSON(res, 200, { ok: true, sites: store.sites });
  if (p === '/api/sites' && req.method === 'POST') {
    const b = await readJSONBody(req);
    const name = String(b.name || '').trim();
    if (!name) return sendJSON(res, 400, { ok: false, error: 'Name fehlt.' });
    let slug = slugify(b.slug || name);
    if (findSite(slug)) return sendJSON(res, 409, { ok: false, error: 'Es gibt schon eine Site mit diesem Kürzel: ' + slug });
    const type = b.type === 'php' ? 'php' : 'static';
    let port = parseInt(b.port, 10) || nextFreePort();
    if (!port) return sendJSON(res, 400, { ok: false, error: 'Kein freier Port mehr im Bereich — Bereich in der .env vergrößern.' });
    if (port !== CFG.uiPort && (port < CFG.portStart || port > CFG.portEnd))
      return sendJSON(res, 400, { ok: false, error: 'Port muss im Bereich ' + CFG.portStart + '–' + CFG.portEnd + ' liegen.' });
    if (usedPorts().has(port)) return sendJSON(res, 409, { ok: false, error: 'Port ' + port + ' ist schon vergeben.' });
    fs.mkdirSync(sitePublic(slug), { recursive: true });
    fs.writeFileSync(path.join(sitePublic(slug), 'index.html'), starterHTML(name));
    const site = { slug, name, type, port, enabled: true,
      pathAlias: type === 'static', protected: [], createdAt: Date.now(), note: '' };
    store.sites.push(site); saveStore();
    sh('chown', ['-R', 'www-data:www-data', path.dirname(sitePublic(slug))], {}, () => {});
    return applyCaddy(err => sendJSON(res, 200, { ok: true, site, caddyError: err || undefined }));
  }

  /* ---- Sites: /api/sites/<slug>[/...] ---- */
  const m = /^\/api\/sites\/([a-z0-9-]+)(\/.*)?$/.exec(p);
  if (!m) return sendJSON(res, 404, { ok: false, error: 'Unbekannter API-Pfad.' });
  const site = findSite(m[1]);
  if (!site) return sendJSON(res, 404, { ok: false, error: 'Site nicht gefunden.' });
  const sub = m[2] || '';

  if (sub === '' && req.method === 'GET') return sendJSON(res, 200, { ok: true, site });

  if (sub === '' && req.method === 'PATCH') {
    const b = await readJSONBody(req);
    if (b.name !== undefined) site.name = String(b.name).trim() || site.name;
    if (b.note !== undefined) site.note = String(b.note);
    if (b.enabled !== undefined) site.enabled = !!b.enabled;
    if (b.pathAlias !== undefined) site.pathAlias = !!b.pathAlias;
    if (b.type !== undefined) site.type = b.type === 'php' ? 'php' : 'static';
    if (b.protected !== undefined && Array.isArray(b.protected))
      site.protected = b.protected.map(x => String(x).trim()).filter(Boolean).slice(0, 30);
    if (b.port !== undefined) {
      const port = parseInt(b.port, 10);
      if (!port || port < CFG.portStart || port > CFG.portEnd)
        return sendJSON(res, 400, { ok: false, error: 'Port muss im Bereich ' + CFG.portStart + '–' + CFG.portEnd + ' liegen.' });
      if (port !== site.port && usedPorts().has(port))
        return sendJSON(res, 409, { ok: false, error: 'Port ' + port + ' ist schon vergeben.' });
      site.port = port;
    }
    saveStore();
    return applyCaddy(err => sendJSON(res, 200, { ok: true, site, caddyError: err || undefined }));
  }

  if (sub === '' && req.method === 'DELETE') {
    const withFiles = url.searchParams.get('files') === '1';
    store.sites = store.sites.filter(s => s.slug !== site.slug);
    saveStore(); A.delete(site.slug);
    if (withFiles) {
      for (const dir of [path.dirname(sitePublic(site.slug)), anaDir(site.slug)])
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(logPath(site.slug), { force: true }); } catch (_) {}
    }
    return applyCaddy(err => sendJSON(res, 200, { ok: true, caddyError: err || undefined }));
  }

  /* ---- Dateimanager ---- */
  if (sub === '/files' && req.method === 'GET') {
    const dir = safePath(site.slug, url.searchParams.get('dir') || '');
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
        let size = 0, mtime = 0;
        try { const st = fs.statSync(path.join(dir, e.name)); size = st.size; mtime = st.mtimeMs; } catch (_) {}
        return { name: e.name, dir: e.isDirectory(), size, mtime };
      }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    } catch (e) { return sendJSON(res, 400, { ok: false, error: 'Ordner nicht lesbar: ' + e.message }); }
    return sendJSON(res, 200, { ok: true, entries });
  }

  if (sub === '/file' && req.method === 'GET') {
    const fp = safePath(site.slug, url.searchParams.get('path') || '');
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory())
      return sendJSON(res, 404, { ok: false, error: 'Datei nicht gefunden.' });
    const download = url.searchParams.get('download') === '1';
    const ext = path.extname(fp).toLowerCase();
    if (download) {
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="' + path.basename(fp).replace(/"/g, '') + '"',
      });
      return fs.createReadStream(fp).pipe(res);
    }
    const st = fs.statSync(fp);
    if (st.size > 2 * 1024 * 1024) return sendJSON(res, 413, { ok: false, error: 'Datei zu groß für den Editor (max. 2 MB) — bitte herunterladen.' });
    return sendJSON(res, 200, { ok: true, content: fs.readFileSync(fp, 'utf8'), size: st.size });
  }

  if (sub === '/file' && req.method === 'PUT') {
    const fp = safePath(site.slug, url.searchParams.get('path') || '');
    const body = await readBody(req, 8 * 1024 * 1024);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, body);
    sh('chown', ['www-data:www-data', fp], {}, () => {});
    return sendJSON(res, 200, { ok: true });
  }

  if (sub === '/fileop' && req.method === 'POST') {
    const b = await readJSONBody(req);
    try {
      if (b.op === 'mkdir') fs.mkdirSync(safePath(site.slug, b.path), { recursive: true });
      else if (b.op === 'delete') fs.rmSync(safePath(site.slug, b.path), { recursive: true, force: true });
      else if (b.op === 'rename') fs.renameSync(safePath(site.slug, b.path), safePath(site.slug, b.to));
      else if (b.op === 'newfile') {
        const fp = safePath(site.slug, b.path);
        if (fs.existsSync(fp)) throw new Error('Datei existiert schon.');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, '');
      } else throw new Error('Unbekannte Aktion.');
    } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    sh('chown', ['-R', 'www-data:www-data', sitePublic(site.slug)], {}, () => {});
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- Upload: einzelne Datei oder ZIP (mit Entpacken) ---- */
  if (sub === '/upload' && req.method === 'PUT') {
    const dirRel  = url.searchParams.get('dir') || '';
    const name    = path.basename(url.searchParams.get('name') || 'upload.bin');
    const extract = url.searchParams.get('extract') === '1';
    const clean   = url.searchParams.get('clean') === '1';
    const targetDir = safePath(site.slug, dirRel);
    fs.mkdirSync(targetDir, { recursive: true });
    const tmp = path.join(CFG.dataDir, 'tmp', 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        let size = 0;
        req.on('data', c => { size += c.length; if (size > 1024 * 1024 * 1024) { reject(new Error('Upload größer als 1 GB.')); req.destroy(); } });
        req.pipe(ws);
        ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
      });
      if (extract) {
        if (clean) {
          for (const e of fs.readdirSync(targetDir))
            fs.rmSync(path.join(targetDir, e), { recursive: true, force: true });
        }
        await new Promise((resolve, reject) =>
          sh('unzip', ['-o', '-q', tmp, '-d', targetDir], {}, err => err ? reject(new Error('Entpacken fehlgeschlagen: ' + err)) : resolve()));
      } else {
        fs.copyFileSync(tmp, path.join(targetDir, name));
      }
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      return sendJSON(res, 400, { ok: false, error: e.message });
    }
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    sh('chown', ['-R', 'www-data:www-data', sitePublic(site.slug)], {}, () => {});
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- Export als ZIP ---- */
  if (sub === '/export' && req.method === 'GET') {
    const tmp = path.join(CFG.dataDir, 'tmp', site.slug + '-' + Date.now() + '.zip');
    return sh('zip', ['-r', '-q', tmp, '.'], { cwd: sitePublic(site.slug) }, (err) => {
      if (err) return sendJSON(res, 500, { ok: false, error: 'ZIP fehlgeschlagen: ' + err });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + site.slug + '.zip"',
      });
      const rs = fs.createReadStream(tmp);
      rs.pipe(res);
      rs.on('close', () => { try { fs.rmSync(tmp, { force: true }); } catch (_) {} });
    });
  }

  /* ---- Analytics ---- */
  if (sub === '/stats' && req.method === 'GET') {
    const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 30));
    return sendJSON(res, 200, Object.assign({ ok: true }, statsFor(site.slug, days)));
  }
  if (sub === '/live' && req.method === 'GET') {
    const st = anaState(site.slug);
    const now = Date.now();
    return sendJSON(res, 200, {
      ok: true,
      liveCount: st.live.filter(e => e.page && now - e.t < 5 * 60 * 1000).length,
      events: st.live.slice(-100).reverse(),
    });
  }

  return sendJSON(res, 404, { ok: false, error: 'Unbekannter API-Pfad.' });
}

/* ------------------------------- UI ausliefern ---------------------------- */
function serveUI(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.normalize(path.join(CFG.uiDir, rel));
  if (!fp.startsWith(CFG.uiDir) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    /* SPA: alles Unbekannte → index.html (Hash-Router) */
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(CFG.uiDir, 'index.html')).pipe(res);
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
}

/* --------------------------------- Start ---------------------------------- */
function main() {
  ensureDirs();
  loadStore();
  seedImport();
  writeCaddyfile();
  /* Falls Caddy schon läuft (Manager-Neustart im laufenden Container): neu laden */
  applyCaddy(() => {});

  setInterval(pollLogs, 2000);
  setInterval(() => {
    for (const [slug, st] of A) if (st.dirty) try { persistAgg(slug, st); } catch (_) {}
  }, 10000);
  process.on('SIGTERM', () => {
    for (const [slug, st] of A) if (st.dirty) try { persistAgg(slug, st); } catch (_) {}
    process.exit(0);
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      handleAPI(req, res, url).catch(e => {
        console.error('[api]', e);
        try { sendJSON(res, 500, { ok: false, error: 'Interner Fehler: ' + e.message }); } catch (_) {}
      });
    } else serveUI(req, res, url);
  });
  server.listen(CFG.managerPort, '127.0.0.1', () =>
    console.log('[webhafen] Manager läuft auf 127.0.0.1:' + CFG.managerPort
      + ' — UI über Port ' + CFG.uiPort));
}
main();
