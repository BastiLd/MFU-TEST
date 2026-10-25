'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

function cleanHostname(value) {
  const name = String(value == null ? '' : value).trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name : null;
}
function failure(message, status = 400) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Every site owns a userspace node, not the host's Tailscale identity. Nothing
   touches the ZimaOS daemon, its shares, routes or existing Serve config. */
class TailscaleManager {
  constructor(options) {
    this.root = path.join(options.dataDir, 'tailscale');
    this.runtimeDir = options.runtimeDir || '/run/webhafen-ts';
    this.secret = options.secret;
    this.authKey = options.authKey === undefined ? (process.env.TAILSCALE_AUTHKEY || '') : options.authKey;
    this.getSites = options.getSites;
    this.saveSites = options.saveSites;
    this.spawn = options.spawn || childProcess.spawn;
    this.run = options.run || ((args, opts = {}) => new Promise((resolve, reject) => {
      childProcess.execFile('tailscale', args, {
        timeout: opts.timeout || 25000, maxBuffer: 1024 * 1024,
        env: this.childEnv(),
      }, (err, stdout, stderr) => {
        if (err) return reject(new Error(this.safeError(String(stderr || stdout || err.message))));
        resolve(String(stdout));
      });
    }));
    this.children = new Map();
    this.busy = new Set();
    this.stopping = false;
    this.timer = null;
  }

  childEnv() {
    // Hosted PHP/scripts and Tailscale subprocesses do not need the manager key.
    const env = { ...process.env };
    for (const key of ['TAILSCALE_AUTHKEY', 'ADMIN_PASSWORD', 'APP_SECRET']) delete env[key];
    return env;
  }
  privateDirs() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
  }
  encryptionKey() {
    if (!this.secret || ['webhafen_dev_secret', 'webhafen_bitte_aendern'].includes(this.secret))
      throw failure('Bitte zuerst einen eigenen, dauerhaften APP_SECRET in der Container-Konfiguration setzen.');
    return crypto.scryptSync(this.secret, 'webhafen-tailscale-v1', 32);
  }
  readKey() {
    if (this.authKey) return this.authKey;
    const file = path.join(this.root, 'config.json');
    if (!fs.existsSync(file)) return '';
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(value.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(value.data, 'hex')), decipher.final()]).toString('utf8');
    } catch (_) {
      throw failure('Der gespeicherte Tailscale-Key ist nicht lesbar. APP_SECRET beibehalten oder Key neu speichern.');
    }
  }
  saveKey(value) {
    if (this.authKey) throw failure('Der Key wird über TAILSCALE_AUTHKEY gesetzt. Bitte dort ändern.');
    const key = String(value || '').trim();
    if (!/^tskey-auth-[A-Za-z0-9-]{10,}$/.test(key))
      throw failure('Bitte einen Tailscale Auth-Key (tskey-auth-…) eintragen, keinen API-Key.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    this.privateDirs();
    const file = path.join(this.root, 'config.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  removeKey() {
    if (this.authKey) throw failure('TAILSCALE_AUTHKEY ist in der Container-Konfiguration gesetzt. Bitte dort entfernen.');
    fs.rmSync(path.join(this.root, 'config.json'), { force: true });
  }
  async configStatus() {
    let available = true, configured = false, error;
    try { await this.run(['version']); } catch (_) { available = false; }
    try { configured = !!this.readKey(); } catch (e) { error = e.message; }
    return { available, configured, source: this.authKey ? 'environment' : fs.existsSync(path.join(this.root, 'config.json')) ? 'saved' : 'none', error };
  }
  safeError(value) {
    return String(value).replace(/tskey-[a-z]+-[A-Za-z0-9_-]+/gi, '[Key entfernt]').slice(0, 1800);
  }
  socket(site) { return path.join(this.runtimeDir, site.slug + '.sock'); }
  unsafeFile(site) { return path.join(this.root, site.slug, 'unsafe-route'); }
  blockState(site) {
    const dir = path.dirname(this.unsafeFile(site));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.unsafeFile(site), 'Serve reset could not be confirmed. Keep this identity offline.\n', { mode: 0o600 });
  }
  cli(site, args, opts) { return this.run(['--socket=' + this.socket(site), ...args], opts); }
  async nodeStatus(site) { return JSON.parse(await this.cli(site, ['status', '--json'])); }
  assertIdle(site) {
    if (this.busy.has(site.slug)) throw failure('Die Tailscale-Adresse wird gerade bearbeitet. Bitte kurz warten.', 409);
  }
  validate(site, options) {
    const hostname = cleanHostname(options.hostname);
    if (!hostname) throw failure('Der Name darf 1–63 Kleinbuchstaben, Ziffern und Bindestriche enthalten; kein Punkt oder Leerzeichen.');
    const mode = options.mode === undefined ? 'private' : options.mode;
    if (!['private', 'public'].includes(mode)) throw failure('Zugriff muss privat oder öffentlich sein.');
    if (site.tailscale && site.tailscale.hostname !== hostname)
      throw failure('Zum Ändern des Namens bitte zuerst die bestehende Tailscale-Adresse entfernen.', 409);
    if (this.getSites().some(s => s.slug !== site.slug && s.tailscale && s.tailscale.hostname === hostname))
      throw failure('Dieser Tailscale-Name wird bereits von einer anderen Website benutzt.', 409);
    if (!site.enabled) throw failure('Bitte die Website vor dem Erstellen der Adresse aktivieren.');
    return { hostname, mode };
  }
  async ensureDaemon(site) {
    if (this.children.has(site.slug)) return;
    if (fs.existsSync(this.unsafeFile(site)))
      throw failure('Diese Tailscale-Identität bleibt aus Sicherheitsgründen offline. Bitte die Adresse entfernen, das alte Gerät in Tailscale löschen und neu erstellen.');
    if (this.stopping) throw failure('WebHafen wird gerade beendet.', 503);
    this.privateDirs();
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.runtimeDir, 0o700);
    const stateDir = path.join(this.root, site.slug);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // Recover after SIGKILL during login without retaining a plaintext key.
    for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
      if (entry.isFile() && /^auth-[a-f0-9]{16}$/.test(entry.name)) fs.rmSync(path.join(stateDir, entry.name), { force: true });
    }
    // Only our own socket path, never the system tailscaled socket.
    fs.rmSync(this.socket(site), { force: true });
    const child = this.spawn('tailscaled', [
      '--tun=userspace-networking', '--port=0', '--statedir=' + stateDir,
      '--socket=' + this.socket(site),
    ], { stdio: 'ignore', env: this.childEnv() });
    this.children.set(site.slug, child);
    let spawnError;
    child.on('error', e => { spawnError = e; });
    child.on('exit', () => {
      if (this.children.get(site.slug) === child) this.children.delete(site.slug);
    });
    for (let i = 0; i < 40; i++) {
      if (spawnError) break;
      try { await this.nodeStatus(site); return; } catch (_) {}
      await delay(150);
    }
    this.kill(site);
    throw failure(spawnError ? 'Tailscale ist in diesem Image nicht verfügbar.' : 'Der Tailscale-Dienst konnte nicht gestartet werden.', 503);
  }
  kill(site) {
    const child = this.children.get(site.slug);
    if (child) { this.children.delete(site.slug); child.kill('SIGTERM'); }
  }
  async authenticate(site) {
    let status = await this.nodeStatus(site);
    if (status.BackendState !== 'Running' || status.Self && status.Self.KeyExpired) {
      const key = this.readKey();
      if (!key) throw failure('Bitte unter System → Tailscale einen wiederverwendbaren Auth-Key hinterlegen.');
      const keyPath = path.join(this.root, site.slug, 'auth-' + crypto.randomBytes(8).toString('hex'));
      try {
        fs.writeFileSync(keyPath, key, { mode: 0o600 });
        await this.cli(site, ['up', '--auth-key=file:' + keyPath, '--hostname=' + site.tailscale.hostname,
          '--accept-dns=false', '--accept-routes=false', '--timeout=25s'], { timeout: 30000 });
      } finally { fs.rmSync(keyPath, { force: true }); }
    } else {
      await this.cli(site, ['set', '--hostname=' + site.tailscale.hostname]);
    }
    // The control plane may need a moment to assign DNS after registration.
    for (let i = 0; i < 15; i++) {
      status = await this.nodeStatus(site);
      if (status.BackendState === 'Running' && status.Self && status.Self.DNSName) break;
      await delay(300);
    }
    if (status.BackendState !== 'Running' || !status.Self || status.Self.KeyExpired)
      throw failure('Tailscale wartet auf Anmeldung oder Gerätefreigabe. Bitte in der Tailscale-Verwaltung prüfen.');
    const dns = String(status.Self.DNSName || '').replace(/\.$/, '').toLowerCase();
    if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(dns))
      throw failure('Noch kein Tailscale-DNS-Name verfügbar. MagicDNS und HTTPS in der Tailscale-Verwaltung aktivieren.');
    if (dns.split('.')[0] !== site.tailscale.hostname)
      throw failure('Tailscale hat den Namen „' + dns.split('.')[0] + '“ vergeben. Der gewünschte Name ist wahrscheinlich bereits belegt; bitte einen anderen wählen.');
    return dns;
  }
  async configure(site) {
    await this.ensureDaemon(site);
    // Reset is intentionally done before auth and before a mode change: a failed
    // switch from public to private must never leave the old Funnel enabled.
    const current = await this.nodeStatus(site);
    if (current.BackendState === 'Running') await this.cli(site, ['serve', 'reset']);
    const dns = await this.authenticate(site);
    await this.cli(site, ['serve', 'reset']);
    const command = site.tailscale.mode === 'public' ? 'funnel' : 'serve';
    await this.cli(site, [command, '--bg', '--yes', '--https=443', 'http://127.0.0.1:' + site.port]);
    const applied = JSON.parse(await this.cli(site, ['serve', 'status', '--json']));
    const hostPort = dns + ':443';
    const handler = applied.Web && applied.Web[hostPort] && applied.Web[hostPort].Handlers && applied.Web[hostPort].Handlers['/'];
    if (!handler || handler.Proxy !== 'http://127.0.0.1:' + site.port ||
        !!(applied.AllowFunnel && applied.AllowFunnel[hostPort]) !== (site.tailscale.mode === 'public'))
      throw failure('Tailscale hat die gewünschte HTTPS-Freigabe nicht bestätigt. MagicDNS, HTTPS und gegebenenfalls die Funnel-Berechtigung prüfen.');
    site.tailscale.status = 'ready';
    site.tailscale.url = 'https://' + dns;
    site.tailscale.error = '';
    site.publicUrl = site.tailscale.url;
    this.saveSites();
  }
  async background(site) {
    try { await this.configure(site); }
    catch (e) {
      // Clear persisted routes as well as stopping the process. If reset fails,
      // the durable marker prevents an old Funnel from reviving during retry.
      if (this.children.has(site.slug)) {
        try { await this.cli(site, ['serve', 'reset']); }
        catch (_) { this.blockState(site); }
      }
      this.kill(site);
      site.tailscale.status = 'error';
      site.tailscale.error = this.safeError(e.message) + ' Prüfe Auth-Key, Gerätefreigabe, MagicDNS und HTTPS in Tailscale.';
      this.saveSites();
    } finally { this.busy.delete(site.slug); }
  }
  async provision(site, options) {
    this.assertIdle(site);
    const config = this.validate(site, options);
    if (!site.tailscale && !this.readKey())
      throw failure('Bitte unter System → Tailscale zuerst einen wiederverwendbaren Auth-Key hinterlegen.');
    this.busy.add(site.slug);
    const previous = site.tailscale;
    // Revoke a current public route BEFORE storing a request for private mode.
    // Even a manager restart between these steps cannot revive an old Funnel.
    if (previous && previous.mode === 'public' && config.mode === 'private') {
      try {
        await this.ensureDaemon(site);
        const status = await this.nodeStatus(site);
        if (status.BackendState === 'Running') await this.cli(site, ['serve', 'reset']);
      } catch (e) {
        this.blockState(site);
        this.kill(site);
        previous.status = 'error';
        previous.error = 'Die öffentliche Freigabe konnte nicht zurückgesetzt werden. Tailscale wurde gestoppt; bitte erneut versuchen.';
        this.saveSites(); this.busy.delete(site.slug);
        throw failure(previous.error, 503);
      }
    }
    site.tailscale = { ...config, status: 'starting', url: previous && previous.url || '', error: '',
      previousPublicUrl: previous ? previous.previousPublicUrl : (site.publicUrl || '') };
    this.saveSites();
    void this.background(site);
  }
  async getStatus(site) {
    if (site.tailscale && site.tailscale.status === 'ready' && site.enabled && !this.busy.has(site.slug)) {
      try {
        const status = await this.nodeStatus(site);
        if (status.BackendState !== 'Running' || status.Self && status.Self.KeyExpired) throw new Error('Nicht verbunden');
      } catch (_) {
        site.tailscale.status = 'error';
        site.tailscale.error = 'Tailscale ist nicht verbunden. Bitte Adresse erneut erstellen und Gerätefreigabe prüfen.';
        this.saveSites();
      }
    }
    return site;
  }
  async remove(site) {
    this.assertIdle(site);
    if (!site.tailscale) return;
    this.busy.add(site.slug);
    try {
      let quarantine = fs.existsSync(this.unsafeFile(site)) ||
        (!this.children.has(site.slug) && site.tailscale.mode === 'public');
      if (this.children.has(site.slug)) {
        try { await this.cli(site, ['serve', 'reset']); }
        catch (_) { this.blockState(site); quarantine = true; }
      }
      const child = this.children.get(site.slug);
      this.kill(site);
      if (quarantine) {
        // Preserve the unsafe identity for recovery, but never launch it again.
        // A new identity may need its old hostname removed in the admin console.
        if (child && child.exitCode == null) {
          await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
          if (child.exitCode == null) { child.kill('SIGKILL'); await delay(200); }
        }
        const archive = path.join(this.root, '.quarantine');
        fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
        const stateDir = path.join(this.root, site.slug);
        if (fs.existsSync(stateDir)) fs.renameSync(stateDir, path.join(archive, site.slug + '-' + crypto.randomBytes(8).toString('hex')));
      }
      site.publicUrl = site.tailscale.previousPublicUrl || '';
      delete site.tailscale;
      this.saveSites();
    } finally { this.busy.delete(site.slug); }
  }
  async reconcile(site) {
    this.assertIdle(site);
    if (!site.tailscale) return;
    this.busy.add(site.slug);
    if (!site.enabled) {
      try {
        // An offline daemon cannot serve traffic; avoid starting paused nodes.
        this.kill(site);
        site.tailscale.status = 'paused';
        site.tailscale.error = '';
        this.saveSites();
      } finally { this.busy.delete(site.slug); }
    } else {
      site.tailscale.status = 'starting';
      this.saveSites();
      void this.background(site);
    }
  }
  start() {
    for (const site of this.getSites()) {
      if (site.tailscale && site.tailscale.status !== 'error') void this.reconcile(site).catch(() => {});
    }
    // Recover an owned daemon if it exits. Configuration/auth errors need an
    // explicit retry, so a revoked key does not cause endless registrations.
    this.timer = setInterval(() => {
      for (const site of this.getSites()) {
        if (site.tailscale && site.tailscale.status === 'ready' && site.enabled &&
            !this.children.has(site.slug) && !this.busy.has(site.slug)) void this.reconcile(site).catch(() => {});
      }
    }, 15000);
    this.timer.unref();
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const site of this.getSites()) this.kill(site);
  }
}

module.exports = { TailscaleManager, cleanHostname };
