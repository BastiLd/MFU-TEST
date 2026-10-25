'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_FILES = 20000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;

function fail(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; return e; }
function cleanRelativePath(value = '') {
  const v = String(value).trim().replace(/^\.\/$/, '').replace(/\/$/, '');
  if (!v) return '';
  if (v.length > 600 || v.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(v)) return null;
  const parts = v.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) return null;
  return v;
}
function cleanRepoConfig(input = {}) {
  const owner = String(input.owner || '').trim();
  const repo = String(input.repo || '').trim();
  const branch = String(input.branch || 'main').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) throw fail('Bitte einen gültigen GitHub-Konto- oder Organisationsnamen eingeben.');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || ['.', '..'].includes(repo)) throw fail('Bitte den Repository-Namen ohne URL eingeben.');
  if (!branch || branch.length > 240 || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.includes('//') || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.split('/').some(x => x.startsWith('.') || x.endsWith('.lock'))) throw fail('Der Branch-Name ist ungültig. Beispiele: main oder feature/meine-website.');
  const folder = cleanRelativePath(input.folder || '');
  if (folder === null) throw fail('Der Website-Ordner muss ein relativer Repository-Pfad ohne .. sein.');
  if (input.paths !== undefined && !Array.isArray(input.paths)) throw fail('Die Dateiauswahl muss eine Liste von Pfaden sein.');
  const paths = [...new Set((input.paths || []).map(p => {
    const clean = cleanRelativePath(p);
    if (clean === null || !clean) throw fail('Die Dateiauswahl enthält einen ungültigen Pfad.');
    return clean;
  }))];
  if (paths.length > 200) throw fail('Bitte höchstens 200 Dateien oder Ordner direkt auswählen.');
  const intervalMinutes = input.intervalMinutes === undefined ? 15 : Number(input.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) throw fail('Das Prüfintervall muss zwischen 5 und 1440 Minuten liegen.');
  for (const key of ['autoCheck', 'autoUpdate']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw fail('Die automatische Prüfung und Installation müssen ein- oder ausgeschaltet sein.');
  return { owner, repo, branch, folder, paths, autoCheck: input.autoCheck !== false, autoUpdate: input.autoUpdate === true, intervalMinutes };
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function readJSON(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function blobOid(data) { return crypto.createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex'); }
function configId(g) { return JSON.stringify([g.owner.toLowerCase(), g.repo.toLowerCase(), g.branch, g.folder, [...g.paths].sort()]); }
function sanitizedError(value, token = '') {
  let out = String(value || 'Unbekannter GitHub-Fehler.');
  if (token) out = out.split(token).join('[Token entfernt]').split(Buffer.from('x-access-token:' + token).toString('base64')).join('[Token entfernt]');
  return out.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[Token entfernt]').slice(0, 1500);
}

class GithubManager {
  constructor(options) {
    this.root = path.join(options.dataDir, 'github');
    this.secret = options.secret;
    this.getSites = options.getSites;
    this.saveSites = options.saveSites;
    this.sitePublic = options.sitePublic;
    this.onFilesChanged = options.onFilesChanged || (async () => {});
    this.isSiteBusy = options.isSiteBusy || (() => false);
    this.fetch = options.fetch || globalThis.fetch;
    this.run = options.run || ((args, opts = {}) => new Promise((resolve, reject) => {
      execFile('git', args, { timeout: 120000, maxBuffer: MAX_FILE + 65536, encoding: 'buffer', ...opts }, (err, stdout, stderr) => {
        if (err) return reject(fail(sanitizedError(Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr || err.message), 502));
        resolve(stdout);
      });
    }));
    this.busy = new Set();
    this.previews = new Map();
    this.stopping = false;
    this.timer = null;
  }
  stateDir(site) { return path.join(this.root, site.slug); }
  manifestFile(site) { return path.join(this.stateDir(site), 'deployed.json'); }
  backupFile(site) { return path.join(this.stateDir(site), 'backup.json'); }
  pendingFile(site) { return path.join(this.stateDir(site), 'pending.json'); }
  tokenFile(site) { return path.join(this.stateDir(site), 'token.json'); }
  dirs(site) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
    if (site) fs.mkdirSync(this.stateDir(site), { recursive: true, mode: 0o700 });
  }
  encryptionKey() {
    if (!this.secret || ['webhafen_dev_secret', 'webhafen_bitte_aendern'].includes(this.secret)) throw fail('Zum Speichern eines GitHub-Tokens zuerst einen eigenen dauerhaften APP_SECRET setzen.');
    if (!this.derivedKey) this.derivedKey = crypto.scryptSync(this.secret, 'webhafen-github-v1', 32);
    return this.derivedKey;
  }
  readToken(site) {
    const value = readJSON(this.tokenFile(site));
    if (!value) return '';
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(value.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(value.data, 'hex')), decipher.final()]).toString('utf8');
    } catch (_) { throw fail('Der GitHub-Token ist nicht lesbar. APP_SECRET beibehalten oder den Token neu speichern.'); }
  }
  encryptedToken(token) {
    if (!/^(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{10,240}$/.test(token)) throw fail('Bitte einen gültigen GitHub Personal Access Token eintragen (github_pat_… oder ghp_…).');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
  }
  assertIdle(site) {
    if (this.stopping) throw fail('WebHafen wird gerade beendet.', 503);
    if (this.busy.has(site.slug) || this.isSiteBusy(site)) throw fail('Diese Website wird gerade bearbeitet. Bitte kurz warten.', 409);
    if (fs.existsSync(this.pendingFile(site))) throw fail('Ein unterbrochenes Update muss zuerst beim Neustart von WebHafen wiederhergestellt werden.', 409);
  }
  configured(site) { if (!site.github) throw fail('Bitte zuerst ein GitHub-Repository für diese Website speichern.'); return site.github; }
  async locked(site, operation) {
    this.assertIdle(site); this.busy.add(site.slug);
    if (site.github) site.github.busy = true;
    try { return await operation(); }
    finally { this.busy.delete(site.slug); if (site.github) site.github.busy = false; }
  }
  async configure(site, body) {
    return this.locked(site, async () => {
      if (site.type === 'proxy') throw fail('Eine Weiterleitung betreibt den Server außerhalb von WebHafen. GitHub-Updates sind für statische und PHP-Websites verfügbar.');
      const clean = cleanRepoConfig(body);
      let encrypted;
      if (body.token) encrypted = this.encryptedToken(String(body.token).trim());
      if (body.removeToken !== undefined && typeof body.removeToken !== 'boolean') throw fail('Token entfernen muss ein- oder ausgeschaltet sein.');
      if (body.token && body.removeToken) throw fail('Token entweder ersetzen oder entfernen.');
      const previous = site.github;
      this.dirs(site);
      if (encrypted) atomic(this.tokenFile(site), encrypted);
      if (body.removeToken) fs.rmSync(this.tokenFile(site), { force: true });
      const same = previous && configId(previous) === configId(clean);
      site.github = { ...clean, tokenConfigured: fs.existsSync(this.tokenFile(site)), status: same ? previous.status : 'unconfigured',
        checkedAt: same ? previous.checkedAt : 0, deployedSha: same ? previous.deployedSha : '', latestSha: same ? previous.latestSha : '',
        latestMessage: same ? previous.latestMessage : '', error: '', busy: false, canRollback: fs.existsSync(this.backupFile(site)) };
      this.previews.delete(site.slug);
      this.saveSites();
      return site;
    });
  }
  status(site) {
    if (site.github) {
      site.github.busy = this.busy.has(site.slug);
      site.github.tokenConfigured = fs.existsSync(this.tokenFile(site));
      site.github.canRollback = fs.existsSync(this.backupFile(site));
    }
    return site;
  }
  async api(site, endpoint) {
    const token = this.readToken(site);
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'WebHafen' };
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try { response = await this.fetch('https://api.github.com' + endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw fail('GitHub ist nicht erreichbar: ' + sanitizedError(e.message, token), 502); }
    if (!response.ok) {
      if (response.status === 401) throw fail('Der GitHub-Token ist ungültig oder abgelaufen. Bitte ersetzen.');
      if (response.status === 404) throw fail('Repository oder Branch nicht gefunden. Bei privaten Repositories den Token und seine Leserechte prüfen.');
      if (response.status === 403 || response.status === 429) throw fail('GitHub verweigert den Zugriff oder das API-Limit ist erreicht. Token, Repository-Leserechte und GitHub-Limit prüfen.');
      throw fail('GitHub-Anfrage fehlgeschlagen (HTTP ' + response.status + ').', 502);
    }
    return response.json();
  }
  async repos(site, owner) {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner || '')) throw fail('Bitte zuerst den GitHub-Kontonamen eingeben.');
    const token = this.readToken(site);
    const endpoint = token ? '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member' : '/users/' + encodeURIComponent(owner) + '/repos?per_page=100&sort=updated';
    const result = await this.api(site, endpoint);
    return (Array.isArray(result) ? result : []).filter(r => !token || String(r.owner && r.owner.login).toLowerCase() === owner.toLowerCase())
      .map(r => ({ name: r.name, fullName: r.full_name, private: !!r.private, defaultBranch: r.default_branch }));
  }
  async branches(site, owner, repo) {
    const conf = cleanRepoConfig({ owner, repo });
    const result = await this.api(site, '/repos/' + encodeURIComponent(conf.owner) + '/' + encodeURIComponent(conf.repo) + '/branches?per_page=100');
    return (Array.isArray(result) ? result : []).map(b => ({ name: b.name, sha: b.commit && b.commit.sha }));
  }
  gitEnv(site) {
    const token = this.readToken(site);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(GIT_|GITHUB_|GH_|TAILSCALE_AUTHKEY$|ADMIN_PASSWORD$|APP_SECRET$)/i.test(key)) delete env[key];
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = path.join(this.root, 'empty-config');
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_ALLOW_PROTOCOL = 'https';
    env.GIT_CONFIG_COUNT = token ? '4' : '3';
    env.GIT_CONFIG_KEY_0 = 'credential.helper'; env.GIT_CONFIG_VALUE_0 = '';
    env.GIT_CONFIG_KEY_1 = 'http.followRedirects'; env.GIT_CONFIG_VALUE_1 = 'false';
    env.GIT_CONFIG_KEY_2 = 'core.hooksPath'; env.GIT_CONFIG_VALUE_2 = path.join(this.root, 'no-hooks');
    if (token) { env.GIT_CONFIG_KEY_3 = 'http.https://github.com/.extraheader'; env.GIT_CONFIG_VALUE_3 = 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64'); }
    return env;
  }
  async git(site, args, options = {}) {
    this.dirs(site);
    if (!fs.existsSync(path.join(this.root, 'empty-config'))) fs.writeFileSync(path.join(this.root, 'empty-config'), '', { mode: 0o600 });
    const env = this.gitEnv(site);
    try { return await this.run(args, { cwd: this.stateDir(site), env, timeout: 120000, maxBuffer: MAX_FILE + 65536, ...options }); }
    catch (e) { throw fail(sanitizedError(e.message, this.readToken(site)), e.statusCode || 502); }
  }
  async fetchTree(site) {
    const g = this.configured(site);
    const repoDir = path.join(this.stateDir(site), 'checkout.git');
    if (!fs.existsSync(path.join(repoDir, 'HEAD'))) await this.git(site, ['init', '--bare', repoDir]);
    const prefix = ['--git-dir=' + repoDir];
    await this.git(site, [...prefix, 'fetch', '--depth=1', '--no-tags', '--force', '--', 'https://github.com/' + g.owner + '/' + g.repo + '.git', 'refs/heads/' + g.branch]);
    const sha = String(await this.git(site, [...prefix, 'rev-parse', '--verify', 'FETCH_HEAD'])).trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw fail('GitHub hat keinen gültigen Commit geliefert.', 502);
    const message = String(await this.git(site, [...prefix, 'show', '-s', '--format=%s', sha])).trim().slice(0, 300);
    const raw = await this.git(site, [...prefix, 'ls-tree', '-r', '-l', '-z', sha], { maxBuffer: 16 * 1024 * 1024 });
    const entries = String(raw).split('\0').filter(Boolean).map(line => {
      const m = /^(\d+) (\w+) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]+)$/.exec(line);
      if (!m) throw fail('Die Repository-Dateiliste konnte nicht gelesen werden.', 502);
      return { mode: m[1], type: m[2], oid: m[3], size: m[4] === '-' ? 0 : Number(m[4]), source: m[5] };
    });
    if (entries.length > 150000) throw fail('Das Repository enthält zu viele Dateien. Bitte ein kleineres Website-Repository verwenden.');
    return { sha, message, entries, repoDir };
  }
  excluded(site, rel) {
    const parts = rel.split('/');
    if (parts.some(p => ['.git', '.github', 'node_modules', '.venv', '__pycache__'].includes(p.toLowerCase()) || /^\.env/i.test(p))) return true;
    if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(rel)) return true;
    return (site.protected || []).some(value => {
      const p = String(value).replace(/^\/+|\/+$/g, '');
      return p && (rel === p || rel.startsWith(p + '/'));
    });
  }
  select(site, tree) {
    const g = this.configured(site);
    const files = [], excluded = [], matched = new Set(), portable = new Set();
    let totalBytes = 0;
    for (const item of tree.entries) {
      if (g.folder && !item.source.startsWith(g.folder + '/')) continue;
      const relative = g.folder ? item.source.slice(g.folder.length + 1) : item.source;
      const selections = g.paths.filter(p => relative === p || relative.startsWith(p + '/'));
      if (g.paths.length && !selections.length) continue;
      selections.forEach(p => matched.add(p));
      if (cleanRelativePath(relative) !== relative) throw fail('Ein ausgewählter Repository-Pfad ist nicht sicher: ' + relative);
      if (this.excluded(site, relative)) { excluded.push(relative); continue; }
      if (!['100644', '100755'].includes(item.mode) || item.type !== 'blob') throw fail('Symbolische Links und Submodule können nicht veröffentlicht werden: ' + relative);
      const key = relative.toLowerCase();
      if (portable.has(key)) throw fail('Dateinamen unterscheiden sich nur durch Groß-/Kleinschreibung: ' + relative);
      portable.add(key);
      if (item.size > MAX_FILE) throw fail('Eine ausgewählte Datei ist größer als 64 MB: ' + relative);
      totalBytes += item.size;
      if (files.length >= MAX_FILES || totalBytes > MAX_BYTES) throw fail('Die Auswahl ist zu groß (maximal 20.000 Dateien und 512 MB).');
      files.push({ ...item, path: relative });
    }
    for (const p of g.paths) if (!matched.has(p)) throw fail('Der ausgewählte Pfad existiert im Branch nicht: ' + p);
    if (!files.length) throw fail('Die Auswahl enthält keine veröffentlichbaren Website-Dateien. Ordner, Branch und ausgeschlossene Daten prüfen.');
    files.sort((a, b) => a.path.localeCompare(b.path));
    const fingerprint = crypto.createHash('sha256').update(files.map(f => f.path + '\0' + f.oid + '\0').join('')).digest('hex');
    return { ...tree, files, excluded, totalBytes, fingerprint };
  }
  async tree(site, value = '', repositoryScope = false) {
    return this.locked(site, async () => {
      const rel = cleanRelativePath(value);
      if (rel === null) throw fail('Ungültiger Ordnerpfad.');
      const tree = await this.fetchTree(site);
      const folder = repositoryScope ? '' : this.configured(site).folder;
      const prefix = [folder, rel].filter(Boolean).join('/');
      const entries = new Map();
      for (const entry of tree.entries) {
        if (prefix && !entry.source.startsWith(prefix + '/')) continue;
        const remaining = prefix ? entry.source.slice(prefix.length + 1) : entry.source;
        const parts = remaining.split('/');
        const name = parts[0];
        if (!name) continue;
        const itemPath = [rel, name].filter(Boolean).join('/');
        if (!entries.has(name)) entries.set(name, { name, path: itemPath, type: parts.length > 1 ? 'dir' : 'file', size: parts.length > 1 ? 0 : entry.size });
      }
      return { path: rel, entries: [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)), sha: tree.sha };
    });
  }
  target(site, rel) {
    if (cleanRelativePath(rel) !== rel || !rel) throw fail('Unsicherer Zielpfad.');
    const root = path.resolve(this.sitePublic(site.slug));
    try { const rootStat = fs.lstatSync(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.lstatSync(path.dirname(root)).isSymbolicLink()) throw fail('Der Website-Ordner muss ein echtes Verzeichnis ohne symbolischen Link sein.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const target = path.resolve(root, ...rel.split('/'));
    if (!target.startsWith(root + path.sep)) throw fail('Unsicherer Zielpfad.');
    const parts = rel.split('/');
    let current = root;
    for (const p of parts) {
      current = path.join(current, p);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw fail('Das Website-Ziel enthält einen symbolischen Link: ' + rel); }
      catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
    }
    return target;
  }
  current(site, rel) {
    const fp = this.target(site, rel);
    try {
      const st = fs.lstatSync(fp);
      if (!st.isFile()) return { kind: 'directory' };
      if (st.size > MAX_FILE) return { kind: 'file', oid: 'oversized', size: st.size };
      return { kind: 'file', oid: blobOid(fs.readFileSync(fp)), size: st.size, mode: st.mode };
    } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
  }
  manifest(site) { return readJSON(this.manifestFile(site), { files: {}, sha: '', fingerprint: '' }); }
  diff(site, selected) {
    const previous = this.manifest(site);
    const add = [], change = [], remove = [], conflicts = [], existing = [];
    const incoming = new Map(selected.files.map(f => [f.path, f]));
    const initial = !previous.sha;
    let sameSource = true;
    if (previous.config) {
      try {
        const old = JSON.parse(previous.config), current = JSON.parse(configId(site.github));
        sameSource = old[0] === current[0] && old[1] === current[1] && old[3] === current[3];
      } catch (_) { sameSource = false; }
    }
    for (const file of selected.files) {
      const old = previous.files[file.path];
      const disk = this.current(site, file.path);
      if (!disk) { add.push(file.path); if (old) conflicts.push(file.path); }
      else if (disk.kind !== 'file') conflicts.push(file.path);
      else if (disk.oid !== file.oid) {
        change.push(file.path);
        if (old && disk.oid !== old.oid) conflicts.push(file.path);
        else if (!old) (initial ? existing : conflicts).push(file.path);
      }
      // An unmanaged file used as an ancestor is never recursively removed.
      const pieces = file.path.split('/');
      for (let i = 1; i < pieces.length; i++) {
        const parent = pieces.slice(0, i).join('/');
        const diskParent = this.current(site, parent);
        if (diskParent && diskParent.kind === 'file' && !(previous.files[parent] && !incoming.has(parent) && diskParent.oid === previous.files[parent].oid)) conflicts.push(parent);
      }
    }
    for (const [rel, old] of Object.entries(previous.files)) {
      const inSelection = !site.github.paths.length || site.github.paths.some(p => rel === p || rel.startsWith(p + '/'));
      if (!sameSource || !inSelection || incoming.has(rel) || this.excluded(site, rel)) continue;
      const disk = this.current(site, rel);
      if (!disk) continue;
      if (disk.kind !== 'file' || disk.oid !== old.oid) conflicts.push(rel);
      else remove.push(rel);
    }
    return { sha: selected.sha, message: selected.message, add, change, remove, conflicts: [...new Set(conflicts)], existing,
      excluded: selected.excluded, fileCount: selected.files.length, totalBytes: selected.totalBytes };
  }
  applyCheck(site, selected) {
    const g = site.github, previous = this.manifest(site);
    g.latestSha = selected.sha; g.latestMessage = selected.message; g.checkedAt = Date.now(); g.error = '';
    g.status = previous.sha && previous.fingerprint === selected.fingerprint ? 'current' : 'update-available';
    if (g.status === 'current' && !g.deployedSha) g.deployedSha = previous.sha;
    this.saveSites();
  }
  async check(site) {
    return this.locked(site, async () => {
      const g = this.configured(site); g.status = 'checking';
      try { const selected = this.select(site, await this.fetchTree(site)); this.applyCheck(site, selected); return site; }
      catch (e) { g.status = 'error'; g.checkedAt = Date.now(); g.error = sanitizedError(e.message); this.saveSites(); throw e; }
    });
  }
  async preview(site) {
    return this.locked(site, async () => {
      const selected = this.select(site, await this.fetchTree(site));
      this.applyCheck(site, selected);
      const preview = this.diff(site, selected);
      this.previews.set(site.slug, { selected, config: configId(site.github), preview });
      return preview;
    });
  }
  async stageFiles(site, selected, dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of selected.files) {
      const content = await this.git(site, ['--git-dir=' + selected.repoDir, 'cat-file', 'blob', file.oid]);
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
      if (data.length !== file.size || blobOid(data) !== file.oid) throw fail('Eine GitHub-Datei stimmt nicht mit dem geprüften Commit überein: ' + file.path);
      if (data.subarray(0, 100).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) throw fail('Git-LFS-Dateien müssen vor der Veröffentlichung als echte Website-Dateien bereitgestellt werden: ' + file.path);
      const fp = path.join(dir, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o755 });
      fs.writeFileSync(fp, data, { mode: 0o644 });
    }
  }
  emptyParents(site, rel) {
    const root = path.resolve(this.sitePublic(site.slug));
    let dir = path.dirname(this.target(site, rel));
    while (dir !== root && dir.startsWith(root + path.sep)) {
      try { fs.rmdirSync(dir); } catch (_) { break; }
      dir = path.dirname(dir);
    }
  }
  writeFrom(site, rel, source) {
    const dest = this.target(site, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.webhafen-' + crypto.randomBytes(8).toString('hex');
    try { fs.copyFileSync(source, tmp); fs.chmodSync(tmp, 0o644); fs.renameSync(tmp, dest); }
    finally { fs.rmSync(tmp, { force: true }); }
  }
  restore(site, snapshot, backupDir) {
    // Remove new versions first, then restore original files. Only touched code
    // paths are restored: runtime databases and unmanaged uploads stay intact.
    for (const op of snapshot.operations) {
      this.target(site, op.path);
      if (op.before) {
        const original = path.join(backupDir, 'files', ...op.path.split('/'));
        if (blobOid(fs.readFileSync(original)) !== op.beforeOid) throw fail('Eine Datei der Sicherung ist beschädigt: ' + op.path);
      }
    }
    for (const op of [...snapshot.operations].sort((a, b) => b.path.length - a.path.length)) {
      const current = this.current(site, op.path);
      if (current && current.kind === 'file') fs.unlinkSync(this.target(site, op.path));
      this.emptyParents(site, op.path);
    }
    for (const op of snapshot.operations.filter(o => o.before).sort((a, b) => a.path.length - b.path.length)) this.writeFrom(site, op.path, path.join(backupDir, 'files', ...op.path.split('/')));
  }
  capture(site, paths, directory, previousManifest = this.manifest(site)) {
    const snapshot = { operations: [], manifest: previousManifest,
      github: { deployedSha: site.github.deployedSha || '', deployedAt: site.github.deployedAt || 0 },
      previousBackup: readJSON(this.backupFile(site)) };
    fs.mkdirSync(path.join(directory, 'files'), { recursive: true, mode: 0o700 });
    for (const rel of paths) {
      const before = this.current(site, rel);
      if (before && before.kind !== 'file') throw fail('Das Ziel hat sich nach der Vorschau geändert: ' + rel, 409);
      snapshot.operations.push({ path: rel, before: !!before, beforeOid: before && before.oid });
      if (before) {
        const dest = path.join(directory, 'files', ...rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(this.target(site, rel), dest);
      }
    }
    atomic(path.join(directory, 'snapshot.json'), snapshot);
    return snapshot;
  }
  restoreMetadata(site, snapshot) {
    atomic(this.manifestFile(site), snapshot.manifest);
    if (snapshot.previousBackup) atomic(this.backupFile(site), snapshot.previousBackup);
    else fs.rmSync(this.backupFile(site), { force: true });
    site.github.deployedSha = snapshot.github.deployedSha; site.github.deployedAt = snapshot.github.deployedAt;
    site.github.canRollback = !!snapshot.previousBackup;
  }
  recover(site) {
    const pending = readJSON(this.pendingFile(site));
    if (!pending) return false;
    if (!/^(?:backup|recover)-[a-f0-9]{16}$/.test(pending.directory)) throw fail('Der Wiederherstellungsnachweis enthält einen ungültigen Pfad.');
    const directory = path.join(this.stateDir(site), pending.directory);
    const snapshot = readJSON(path.join(directory, 'snapshot.json'));
    if (!snapshot || !Array.isArray(snapshot.operations)) throw fail('Die Sicherung für das unterbrochene Update ist nicht lesbar.');
    this.restore(site, snapshot, directory); this.restoreMetadata(site, snapshot);
    fs.rmSync(this.pendingFile(site), { force: true });
    site.github.busy = false; site.github.status = 'error';
    site.github.error = 'Das unterbrochene GitHub-Update wurde auf den vorherigen Dateistand zurückgesetzt. Bitte die Website prüfen und eine neue Vorschau erstellen.';
    this.previews.delete(site.slug); this.saveSites();
    return true;
  }
  async performUpdate(site, selected, preview, approvedExisting = new Set()) {
    const state = this.stateDir(site), id = crypto.randomBytes(8).toString('hex');
    const stage = path.join(state, 'stage-' + id), backupDir = path.join(state, 'backup-' + id);
    let snapshot, applied = false;
    const previous = this.manifest(site), oldBackup = readJSON(this.backupFile(site));
    try {
      await this.stageFiles(site, selected, stage);
      // Staging awaits Git subprocesses. A running website may have changed its
      // files meanwhile, so validate the actual target again before any writes.
      preview = this.diff(site, selected);
      if (preview.conflicts.length) throw fail('Lokale Änderungen während der Vorbereitung verhindern das Update: ' + preview.conflicts.slice(0, 8).join(', '), 409);
      if (preview.existing.some(rel => !approvedExisting.has(rel))) throw fail('Seit der Vorschau sind weitere vorhandene Dateien betroffen. Bitte eine neue Vorschau prüfen und das Ersetzen bestätigen.', 409);
      const changed = [...new Set([...preview.add, ...preview.change, ...preview.remove])];
      if (!changed.length) {
        // Identical imported files still establish ownership and the pinned
        // revision, but a no-op must not replace the last useful rollback.
        const files = Object.fromEntries(selected.files.map(f => [f.path, { oid: f.oid, size: f.size }]));
        atomic(this.manifestFile(site), { files, sha: selected.sha, fingerprint: selected.fingerprint, config: configId(site.github) });
        site.github.deployedSha = selected.sha; site.github.deployedAt = Date.now(); site.github.status = 'current';
        site.github.error = ''; site.github.canRollback = !!oldBackup;
        this.previews.delete(site.slug); this.saveSites();
        return;
      }
      snapshot = this.capture(site, changed, backupDir, previous);
      snapshot.afterSha = selected.sha;
      for (const operation of snapshot.operations) operation.afterOid = (selected.files.find(f => f.path === operation.path) || {}).oid || null;
      atomic(path.join(backupDir, 'snapshot.json'), snapshot);
      atomic(this.pendingFile(site), { directory: path.basename(backupDir), kind: 'update' });
      applied = true;
      for (const rel of [...preview.remove].sort((a, b) => b.length - a.length)) {
        fs.unlinkSync(this.target(site, rel)); this.emptyParents(site, rel);
      }
      for (const rel of [...preview.add, ...preview.change]) this.writeFrom(site, rel, path.join(stage, ...rel.split('/')));
      await this.onFilesChanged(site);
      const files = Object.fromEntries(selected.files.map(f => [f.path, { oid: f.oid, size: f.size }]));
      atomic(this.manifestFile(site), { files, sha: selected.sha, fingerprint: selected.fingerprint, config: configId(site.github) });
      atomic(this.backupFile(site), { directory: path.basename(backupDir), sha: selected.sha });
      site.github.deployedSha = selected.sha; site.github.deployedAt = Date.now(); site.github.status = 'current';
      site.github.error = ''; site.github.canRollback = true;
      this.previews.delete(site.slug); this.saveSites();
      fs.rmSync(this.pendingFile(site), { force: true });
      if (oldBackup && /^backup-[a-f0-9]{16}$/.test(oldBackup.directory)) {
        try { fs.rmSync(path.join(state, oldBackup.directory), { recursive: true, force: true }); } catch (_) { /* A retained old backup must not roll back a successful release. */ }
      }
    } catch (e) {
      if (applied && snapshot) {
        try {
          this.restore(site, snapshot, backupDir);
          this.restoreMetadata(site, snapshot);
          await this.onFilesChanged(site);
          fs.rmSync(this.pendingFile(site), { force: true });
        } catch (rollbackError) { throw fail('Update fehlgeschlagen; Wiederherstellung prüfen. Sicherung: ' + path.basename(backupDir) + '. ' + sanitizedError(rollbackError.message), 500); }
      }
      throw e;
    } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {} }
  }
  async update(site, body = {}) {
    this.assertIdle(site); this.configured(site);
    if (site.type === 'proxy') throw fail('Externe Server einer Weiterleitung werden von WebHafen nicht aktualisiert.');
    const cached = this.previews.get(site.slug);
    if (!cached || body.sha !== cached.selected.sha || cached.config !== configId(site.github)) throw fail('Bitte zuerst eine aktuelle Vorschau erstellen und genau diesen Commit zum Update auswählen.', 409);
    const preview = this.diff(site, cached.selected);
    if (preview.conflicts.length) throw fail('Lokale Änderungen oder Dateikonflikte verhindern das Update: ' + preview.conflicts.slice(0, 8).join(', '), 409);
    if (preview.existing.length && body.overwriteExisting !== true) throw fail('Beim ersten Import würden vorhandene Website-Dateien ersetzt. Bitte die Vorschau prüfen und das Ersetzen ausdrücklich bestätigen.', 409);
    const approvedExisting = new Set(body.overwriteExisting === true ? cached.preview.existing : []);
    if (preview.existing.some(rel => !approvedExisting.has(rel))) throw fail('Seit der Vorschau sind weitere vorhandene Dateien betroffen. Bitte eine neue Vorschau erstellen.', 409);
    this.busy.add(site.slug); site.github.busy = true; site.github.status = 'deploying'; site.github.error = ''; this.saveSites();
    void this.performUpdate(site, cached.selected, preview, approvedExisting).catch(e => {
      site.github.status = 'error'; site.github.error = sanitizedError(e.message); this.saveSites();
    }).finally(() => { this.busy.delete(site.slug); site.github.busy = false; this.saveSites(); });
    return site;
  }
  async rollback(site) {
    this.assertIdle(site); this.configured(site);
    const pointer = readJSON(this.backupFile(site));
    if (!pointer || !/^backup-[a-f0-9]{16}$/.test(pointer.directory)) throw fail('Es gibt noch keine Sicherung eines GitHub-Updates.');
    const backupDir = path.join(this.stateDir(site), pointer.directory), snapshot = readJSON(path.join(backupDir, 'snapshot.json'));
    if (!snapshot) throw fail('Die Sicherung ist nicht lesbar.');
    for (const op of snapshot.operations) {
      if (this.excluded(site, op.path)) throw fail('Dieser Pfad ist inzwischen geschützt oder enthält Laufzeitdaten und kann nicht zurückgesetzt werden: ' + op.path, 409);
      const current = this.current(site, op.path);
      if ((op.afterOid && (!current || current.kind !== 'file' || current.oid !== op.afterOid)) || (!op.afterOid && current)) throw fail('Seit dem Update lokal geänderte Dateien verhindern das Zurücksetzen: ' + op.path, 409);
    }
    this.busy.add(site.slug); site.github.busy = true; site.github.status = 'deploying'; site.github.error = ''; this.saveSites();
    void (async () => {
      const recovery = path.join(this.stateDir(site), 'recover-' + crypto.randomBytes(8).toString('hex'));
      const restorePoint = this.capture(site, snapshot.operations.map(o => o.path), recovery);
      atomic(this.pendingFile(site), { directory: path.basename(recovery), kind: 'rollback' });
      try {
        this.restore(site, snapshot, backupDir);
        atomic(this.manifestFile(site), snapshot.manifest);
        site.github.deployedSha = snapshot.github.deployedSha; site.github.deployedAt = snapshot.github.deployedAt;
        site.github.status = 'update-available'; site.github.canRollback = false;
        fs.rmSync(this.backupFile(site), { force: true });
        this.previews.delete(site.slug); await this.onFilesChanged(site); this.saveSites();
        fs.rmSync(this.pendingFile(site), { force: true });
      } catch (e) {
        this.restore(site, restorePoint, recovery); this.restoreMetadata(site, restorePoint);
        fs.rmSync(this.pendingFile(site), { force: true }); throw e;
      }
      fs.rmSync(recovery, { recursive: true, force: true });
    })().catch(e => { site.github.status = 'error'; site.github.error = sanitizedError(e.message); this.saveSites(); })
      .finally(() => { this.busy.delete(site.slug); site.github.busy = false; this.saveSites(); });
    return site;
  }
  async disconnect(site) {
    return this.locked(site, async () => {
      this.previews.delete(site.slug); fs.rmSync(this.tokenFile(site), { force: true });
      delete site.github; this.saveSites(); return site;
    });
  }
  disposeSite(site) {
    if (this.busy.has(site.slug)) throw fail('Ein GitHub-Update dieser Website läuft noch.', 409);
    this.previews.delete(site.slug);
    const state = this.stateDir(site);
    if (!fs.existsSync(state)) return;
    fs.rmSync(this.tokenFile(site), { force: true });
    const removed = path.join(this.root, '.removed');
    fs.mkdirSync(removed, { recursive: true, mode: 0o700 });
    fs.renameSync(state, path.join(removed, site.slug + '-' + crypto.randomBytes(8).toString('hex')));
  }
  start() {
    for (const site of this.getSites()) if (site.github) {
      site.github.busy = false;
      try {
        const recovered = this.recover(site);
        if (!recovered && ['checking', 'deploying'].includes(site.github.status)) { site.github.status = 'error'; site.github.error = 'Die vorherige GitHub-Aktion wurde unterbrochen. Website und Sicherung prüfen, dann erneut versuchen.'; }
      } catch (e) { site.github.status = 'error'; site.github.error = 'Das unterbrochene Update konnte nicht wiederhergestellt werden: ' + sanitizedError(e.message); this.saveSites(); }
    }
    this.timer = setInterval(() => { void this.tick(); }, 60000); this.timer.unref();
    void this.tick();
  }
  async tick() {
    if (this.stopping) return;
    for (const site of this.getSites()) {
      const g = site.github;
      if (!g || !g.autoCheck || fs.existsSync(this.pendingFile(site)) || this.busy.has(site.slug) || this.isSiteBusy(site) || Date.now() - (g.checkedAt || 0) < g.intervalMinutes * 60000) continue;
      try {
        await this.check(site);
        if (site.github.autoUpdate && site.github.status === 'update-available' && site.github.deployedSha) {
          const preview = await this.preview(site);
          if (!preview.conflicts.length && !preview.existing.length) await this.update(site, { sha: preview.sha });
        }
      } catch (_) { /* site.github.error is visible; the next scheduled check is throttled. */ }
    }
  }
  stop() { this.stopping = true; clearInterval(this.timer); }
}

module.exports = { GithubManager, cleanRepoConfig, cleanRelativePath };
