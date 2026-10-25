'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TailscaleManager, cleanHostname } = require('../app/tailscale');

const TEST_KEY = 'tskey-auth-0123456789abcdefghij-testonly';
const SECRET = 'only-used-for-tests-long-random-secret';

function option(args, flag) {
  const full = args.find(value => value.startsWith(flag + '='));
  if (full) return full.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhafen-ts-test-'));
  const sites = options.sites || [{ slug: 'studio', name: 'Studio', port: 8011,
    enabled: true, publicUrl: 'https://old.example.test' }];
  const calls = [];
  const daemons = [];
  const nodes = new Map();
  let saves = 0;
  const run = async (args, commandOptions) => {
    calls.push({ args: [...args], options: commandOptions });
    if (args.includes('version')) return '1.104.2';
    const socket = option(args, '--socket') || 'default';
    if (!nodes.has(socket)) nodes.set(socket, { hostname: '', authenticated: false });
    const node = nodes.get(socket);
    if ((args.includes('serve') || args.includes('funnel')) && args.includes('status'))
      return JSON.stringify(node.applied || {});
    if (args.includes('status')) return JSON.stringify({
      BackendState: node.authenticated ? 'Running' : 'NeedsLogin',
      Self: node.authenticated ? { ID: 'self-' + socket, HostName: node.hostname,
        DNSName: (options.assignedHostname || node.hostname) + '.example-tail.ts.net.',
        Online: true, KeyExpired: !!options.keyExpired } : null,
      Peer: options.peers || {}, CurrentTailnet: { MagicDNSSuffix: 'example-tail.ts.net' },
    });
    if (args.includes('up') || args.includes('login')) {
      if (options.beforeLogin) await options.beforeLogin();
      node.hostname = option(args, '--hostname') || node.hostname;
      node.authenticated = true;
      return '';
    }
    if (args.includes('set')) {
      node.hostname = option(args, '--hostname') || node.hostname;
      return '';
    }
    if (args.includes('logout')) { node.authenticated = false; return ''; }
    if (args.includes('serve') || args.includes('funnel')) {
      if (args.includes('reset')) {
        if (options.failReset) throw new Error('Simulated reset failure');
        node.applied = {};
        return '';
      }
      if (options.failExposure && !args.includes('off'))
        throw new Error(options.failExposure);
      const hostname = options.assignedHostname || node.hostname;
      const hostPort = hostname + '.example-tail.ts.net:443';
      node.applied = { Web: { [hostPort]: { Handlers: { '/': {
        Proxy: args.find(arg => arg.startsWith('http://127.0.0.1:')),
      } } } }, AllowFunnel: { [hostPort]: args.includes('funnel') } };
      if (options.invalidApplied) node.applied = {};
      return '';
    }
    return '';
  };
  const spawn = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.pid = 9000 + daemons.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0));
      return true;
    };
    daemons.push({ command, args: [...args], options: spawnOptions, child });
    return child;
  };
  const manager = new TailscaleManager({ dataDir, secret: SECRET, getSites: () => sites,
    saveSites: () => { saves++; }, runtimeDir: path.join(dataDir, 'run'),
    run, spawn, authKey: options.authKey === undefined ? TEST_KEY : options.authKey });
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { manager, sites, calls, daemons, dataDir, get saves() { return saves; } };
}

async function settled(site) {
  const deadline = Date.now() + 3000;
  while (!site.tailscale || site.tailscale.status === 'starting') {
    if (Date.now() > deadline) throw new Error('Provisioning did not finish: ' + JSON.stringify(site));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return site.tailscale;
}

test('hostname normalizes one DNS label and rejects domains, paths and shell fragments', () => {
  for (const value of ['studio', 'bot-studio', 'a', 'a'.repeat(63)])
    assert.equal(cleanHostname(value), value);
  assert.equal(cleanHostname(' Studio '), 'studio');
  for (const value of ['', '-studio', 'studio-', 'two words', 'studio.ts.net',
    '../studio', 'studio;id', 'a'.repeat(64), 'studio\nname'])
    assert.equal(cleanHostname(value), null, value);
});

test('saved reusable key is encrypted on disk and never returned by configuration status', async t => {
  const f = fixture(t, { authKey: '' });
  await f.manager.saveKey(TEST_KEY);
  const status = await f.manager.configStatus();
  assert.equal(status.available, true);
  assert.equal(status.configured, true);
  assert.equal(status.source, 'saved');
  assert.equal(JSON.stringify(status).includes(TEST_KEY), false);
  const configFile = path.join(f.dataDir, 'tailscale', 'config.json');
  const disk = fs.readFileSync(configFile, 'utf8');
  assert.equal(disk.includes(TEST_KEY), false);
  const restored = new TailscaleManager({ dataDir: f.dataDir, secret: SECRET,
    getSites: () => f.sites, saveSites: () => {}, run: async () => '1.104.2' });
  assert.equal((await restored.configStatus()).configured, true);
  await f.manager.removeKey();
  assert.equal((await f.manager.configStatus()).configured, false);
});

test('environment key stays configured when a saved key is removed', async t => {
  const f = fixture(t);
  assert.throws(() => f.manager.removeKey(), /TAILSCALE_AUTHKEY/);
  const status = await f.manager.configStatus();
  assert.equal(status.configured, true);
  assert.equal(status.source, 'environment');
});

test('invalid auth keys never overwrite an existing saved key', async t => {
  const f = fixture(t, { authKey: '' });
  await f.manager.saveKey(TEST_KEY);
  for (const value of ['', 'tskey-api-12345678901234', 'arbitrary', TEST_KEY + '\ninvalid'])
    await assert.rejects(async () => f.manager.saveKey(value));
  assert.equal((await f.manager.configStatus()).configured, true);
});

test('domain provisioning defaults to private Serve and uses the actual assigned HTTPS name', async t => {
  const f = fixture(t);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'bot-studio' });
  await settled(site);
  assert.equal(site.tailscale.status, 'ready', site.tailscale.error);
  assert.equal(site.tailscale.mode, 'private');
  assert.equal(site.publicUrl, 'https://bot-studio.example-tail.ts.net');
  assert.ok(f.calls.some(call => call.args.includes('serve') && call.args.includes('--bg')));
  assert.equal(f.calls.some(call => call.args.includes('funnel') && call.args.includes('--bg')), false);
  assert.equal(JSON.stringify(f.calls.map(call => call.args)).includes(TEST_KEY), false);
  assert.ok(f.daemons[0].args.some(arg => arg.includes('userspace-networking')));
  assert.ok(f.saves > 0);
});

test('public access only uses Funnel after explicit public selection', async t => {
  const f = fixture(t);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio', mode: 'public' });
  await settled(site);
  assert.equal(site.tailscale.status, 'ready', site.tailscale.error);
  assert.equal(site.tailscale.mode, 'public');
  assert.ok(f.calls.some(call => call.args.includes('funnel') && call.args.includes('--bg')));
});

test('invalid hostname or access mode changes nothing', async t => {
  const f = fixture(t);
  const site = f.sites[0];
  const initial = JSON.stringify(site);
  await assert.rejects(f.manager.provision(site, { hostname: 'studio.evil.test', mode: 'private' }));
  await assert.rejects(f.manager.provision(site, { hostname: 'studio', mode: 'anything' }));
  assert.equal(JSON.stringify(site), initial);
  assert.equal(f.daemons.length, 0);
});

test('local hostname collision does not create a second Tailscale daemon', async t => {
  const f = fixture(t, { sites: [
    { slug: 'first', enabled: true, port: 8011, tailscale: { hostname: 'taken', mode: 'private', status: 'ready' } },
    { slug: 'second', enabled: true, port: 8012, publicUrl: '' },
  ] });
  await assert.rejects(f.manager.provision(f.sites[1], { hostname: 'taken' }));
  assert.equal(f.daemons.length, 0);
  assert.equal(f.sites[1].tailscale, undefined);
});

test('exposure failure preserves existing manual address and records a useful error', async t => {
  const f = fixture(t, { failExposure: 'Funnel permission has not been granted' });
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio', mode: 'public' });
  await settled(site);
  assert.equal(site.tailscale.status, 'error');
  assert.match(site.tailscale.error, /permission|Funnel/i);
  assert.equal(site.publicUrl, 'https://old.example.test');
});

test('removing a managed domain restores previous manual address and stops its daemon', async t => {
  const f = fixture(t);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio' });
  await settled(site);
  await f.manager.remove(site);
  assert.equal(site.publicUrl, 'https://old.example.test');
  assert.equal(site.tailscale, undefined);
  assert.equal(f.daemons[0].child.exitCode, 0);
});

test('a missing connection key does not mutate website data', async t => {
  const f = fixture(t, { authKey: '' });
  const site = f.sites[0];
  const before = JSON.stringify(site);
  await assert.rejects(f.manager.provision(site, { hostname: 'studio' }), /Auth-Key/);
  assert.equal(JSON.stringify(site), before);
  assert.equal(f.daemons.length, 0);
});

test('a different APP_SECRET reports unreadable stored credentials without exposing them', async t => {
  const f = fixture(t, { authKey: '' });
  await f.manager.saveKey(TEST_KEY);
  const changedSecret = new TailscaleManager({ dataDir: f.dataDir, secret: 'changed-secret',
    getSites: () => f.sites, saveSites: () => {}, run: async () => '1.104.2' });
  const status = await changedSecret.configStatus();
  assert.equal(status.configured, false);
  assert.match(status.error, /APP_SECRET/);
  assert.equal(JSON.stringify(status).includes(TEST_KEY), false);
});

test('a name collision assigned by Tailscale is rejected rather than silently using a suffix', async t => {
  const f = fixture(t, { assignedHostname: 'studio-1' });
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio' });
  await settled(site);
  assert.equal(site.tailscale.status, 'error');
  assert.match(site.tailscale.error, /studio-1/);
  assert.equal(site.publicUrl, 'https://old.example.test');
  assert.equal(f.calls.some(call => call.args.includes('--bg')), false);
  assert.equal(f.daemons[0].child.exitCode, 0);
});

test('failed confirmation of an exposure stops the daemon and never reports ready', async t => {
  const f = fixture(t, { invalidApplied: true });
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio', mode: 'public' });
  await settled(site);
  assert.equal(site.tailscale.status, 'error');
  assert.equal(site.publicUrl, 'https://old.example.test');
  assert.equal(f.daemons[0].child.exitCode, 0);
});

test('concurrent provisioning and removal of one website are rejected until work completes', async t => {
  let completeLogin;
  const gate = new Promise(resolve => { completeLogin = resolve; });
  const f = fixture(t, { beforeLogin: () => gate });
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio' });
  await assert.rejects(f.manager.provision(site, { hostname: 'studio', mode: 'public' }),
    error => error.statusCode === 409);
  await assert.rejects(f.manager.remove(site), error => error.statusCode === 409);
  completeLogin();
  await settled(site);
  assert.equal(site.tailscale.mode, 'private');
  assert.equal(f.daemons.length, 1);
});

test('switching public exposure to private resets the public route before enabling Serve', async t => {
  const f = fixture(t);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio', mode: 'public' });
  await settled(site);
  const marker = f.calls.length;
  await f.manager.provision(site, { hostname: 'studio', mode: 'private' });
  await settled(site);
  assert.equal(site.tailscale.status, 'ready');
  assert.equal(site.tailscale.mode, 'private');
  const switchCalls = f.calls.slice(marker);
  const resetIndex = switchCalls.findIndex(call => call.args.includes('serve') && call.args.includes('reset'));
  const serveIndex = switchCalls.findIndex(call => call.args.includes('serve') && call.args.includes('--bg'));
  assert.ok(resetIndex >= 0 && serveIndex > resetIndex);
  assert.equal(switchCalls.some(call => call.args.includes('funnel') && call.args.includes('--bg')), false);
});

test('failed switch from public to private leaves no daemon serving the old public route', async t => {
  const options = {};
  const f = fixture(t, options);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio', mode: 'public' });
  await settled(site);
  options.failExposure = 'Private configuration failed';
  await f.manager.provision(site, { hostname: 'studio', mode: 'private' });
  await settled(site);
  assert.equal(site.tailscale.status, 'error');
  assert.equal(f.daemons[0].child.exitCode, 0);
});

test('changing the website port updates its proxy without registering another identity', async t => {
  const f = fixture(t);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio' });
  await settled(site);
  site.port = 8020;
  await f.manager.reconcile(site);
  await settled(site);
  assert.equal(site.tailscale.status, 'ready');
  assert.ok(f.calls.some(call => call.args.includes('http://127.0.0.1:8020')));
  assert.equal(f.calls.filter(call => call.args.includes('up')).length, 1);
  assert.equal(f.daemons.length, 1);
});

test('pausing stops the domain and resuming restores the same address', async t => {
  const f = fixture(t);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio' });
  await settled(site);
  const originalUrl = site.publicUrl;
  site.enabled = false;
  await f.manager.reconcile(site);
  assert.equal(site.tailscale.status, 'paused');
  assert.equal(f.daemons[0].child.exitCode, 0);
  site.enabled = true;
  await f.manager.reconcile(site);
  await settled(site);
  assert.equal(site.tailscale.status, 'ready');
  assert.equal(site.publicUrl, originalUrl);
  assert.equal(f.calls.filter(call => call.args.includes('up')).length, 1);
});

test('expired identity is surfaced as disconnected rather than ready', async t => {
  const options = {};
  const f = fixture(t, options);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio' });
  await settled(site);
  options.keyExpired = true;
  const current = await f.manager.getStatus(site);
  assert.equal(current.tailscale.status, 'error');
  assert.match(current.tailscale.error, /verbunden|freigabe/i);
});

test('startup leaves an errored public domain stopped until an explicit retry', async t => {
  const f = fixture(t, { sites: [{ slug: 'studio', enabled: true, port: 8011,
    publicUrl: 'https://studio.example-tail.ts.net', tailscale: {
      hostname: 'studio', mode: 'public', status: 'error',
      error: 'Could not safely reset the old public route',
    } }] });
  f.manager.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.daemons.length, 0);
  assert.equal(f.sites[0].tailscale.status, 'error');
  assert.equal(f.calls.some(call => call.args.includes('funnel')), false);
});

test('daemon startup removes stale auth temp files while preserving identity and unrelated entries', async t => {
  const f = fixture(t);
  const stateDir = path.join(f.dataDir, 'tailscale', 'studio');
  fs.mkdirSync(stateDir, { recursive: true });
  const staleKey = path.join(stateDir, 'auth-0123456789abcdef');
  const identity = path.join(stateDir, 'tailscaled.state');
  const unrelated = path.join(stateDir, 'auth-explanation.txt');
  const directory = path.join(stateDir, 'auth-fedcba9876543210');
  fs.writeFileSync(staleKey, TEST_KEY);
  fs.writeFileSync(identity, '{"testIdentity":"must-survive"}');
  fs.writeFileSync(unrelated, 'keep this');
  fs.mkdirSync(directory);
  await f.manager.provision(f.sites[0], { hostname: 'studio' });
  await settled(f.sites[0]);
  assert.equal(f.sites[0].tailscale.status, 'ready');
  assert.equal(fs.existsSync(staleKey), false);
  assert.equal(fs.readFileSync(identity, 'utf8'), '{"testIdentity":"must-survive"}');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep this');
  assert.equal(fs.statSync(directory).isDirectory(), true);
});

test('a failed public reset blocks retry and archives unsafe identity before fresh private creation', async t => {
  const options = {};
  const f = fixture(t, options);
  const site = f.sites[0];
  await f.manager.provision(site, { hostname: 'studio', mode: 'public' });
  await settled(site);
  assert.equal(site.tailscale.status, 'ready');
  const stateDir = path.join(f.dataDir, 'tailscale', 'studio');
  fs.writeFileSync(path.join(stateDir, 'tailscaled.state'), 'unsafe-old-identity');
  options.failReset = true;
  await assert.rejects(f.manager.provision(site, { hostname: 'studio', mode: 'private' }),
    error => error.statusCode === 503);
  assert.equal(site.tailscale.status, 'error');
  assert.equal(f.daemons[0].child.exitCode, 0);
  assert.equal(fs.existsSync(path.join(stateDir, 'unsafe-route')), true);
  await assert.rejects(f.manager.provision(site, { hostname: 'studio', mode: 'private' }));
  assert.equal(f.daemons.length, 1, 'Unsafe identity must not start again');
  await f.manager.remove(site);
  assert.equal(site.tailscale, undefined);
  assert.equal(site.publicUrl, 'https://old.example.test');
  assert.equal(fs.existsSync(stateDir), false);
  const archives = fs.readdirSync(path.join(f.dataDir, 'tailscale', '.quarantine'));
  assert.equal(archives.length, 1);
  const archived = path.join(f.dataDir, 'tailscale', '.quarantine', archives[0]);
  assert.equal(fs.readFileSync(path.join(archived, 'tailscaled.state'), 'utf8'), 'unsafe-old-identity');
  assert.equal(fs.existsSync(path.join(archived, 'unsafe-route')), true);
  options.failReset = false;
  await f.manager.provision(site, { hostname: 'studio', mode: 'private' });
  await settled(site);
  assert.equal(site.tailscale.status, 'ready');
  assert.equal(site.tailscale.mode, 'private');
  assert.equal(f.daemons.length, 2);
  assert.equal(fs.existsSync(path.join(stateDir, 'tailscaled.state')), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'unsafe-route')), false);
});
