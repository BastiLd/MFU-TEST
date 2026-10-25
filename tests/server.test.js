'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

let child, dataDir, base, cookie;
let output = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function request(route, { method = 'GET', body, session = true, csrf = true } = {}) {
  const headers = {};
  if (session && cookie) headers.Cookie = cookie;
  if (csrf) headers['X-WH'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhafen-http-test-'));
  const port = await freePort();
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, MANAGER_PORT: String(port), DATA_DIR: dataDir,
      SEED_DIR: path.join(dataDir, 'empty-seed'), ADMIN_PASSWORD: 'test-only-password',
      APP_SECRET: 'test-only-secret-not-used-for-real-data', TAILSCALE_AUTHKEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      await fetch(base + '/api/me');
      break;
    } catch (error) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error('Manager did not start: ' + output, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  const login = await request('/api/login', {
    method: 'POST', body: { password: 'test-only-password' }, session: false,
  });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Tailscale configuration and mutations require login and CSRF header', async () => {
  let result = await request('/api/tailscale', { session: false });
  assert.equal(result.response.status, 401);
  result = await request('/api/tailscale', {
    method: 'PUT', body: { authKey: 'never-stored' }, csrf: false,
  });
  assert.equal(result.response.status, 403);
  result = await request('/api/tailscale');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.configured, false);
  assert.equal(typeof result.data.available, 'boolean');
  assert.equal(Object.hasOwn(result.data, 'authKey'), false);
});

test('configuration API encrypts the reusable key, omits it from responses and removes it', async () => {
  const authKey = 'tskey-auth-testonly0123456789-never-register';
  let result = await request('/api/tailscale', {
    method: 'PUT', body: { authKey },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.configured, true);
  assert.equal(result.data.source, 'saved');
  assert.equal(JSON.stringify(result.data).includes(authKey), false);
  const savedFile = path.join(dataDir, 'tailscale', 'config.json');
  assert.equal(fs.readFileSync(savedFile, 'utf8').includes(authKey), false);
  result = await request('/api/tailscale', {
    method: 'PUT', body: { authKey: 'invalid' },
  });
  assert.equal(result.response.status, 400);
  result = await request('/api/tailscale');
  assert.equal(result.data.configured, true);
  result = await request('/api/tailscale', { method: 'DELETE' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.configured, false);
  assert.equal(fs.existsSync(savedFile), false);
});

test('invalid manual address creates neither a website nor its public directory', async () => {
  const result = await request('/api/sites', { method: 'POST', body: {
    name: 'Invalid address', slug: 'invalid-address', publicUrl: 'https://[broken',
  } });
  assert.equal(result.response.status, 400);
  assert.equal(fs.existsSync(path.join(dataDir, 'sites', 'invalid-address')), false);
  const list = await request('/api/sites');
  assert.equal(list.data.sites.some(site => site.slug === 'invalid-address'), false);
});

test('manual custom addresses and ordinary site settings continue to work', async () => {
  const result = await request('/api/sites', { method: 'POST', body: {
    name: 'Existing manual site', slug: 'manual-site', publicUrl: 'https://manual.example.test/',
  } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.site.publicUrl, 'https://manual.example.test');
  assert.equal(result.data.site.enabled, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'sites', 'manual-site', 'public', 'index.html')), true);
  const update = await request('/api/sites/manual-site', { method: 'PATCH', body: {
    publicUrl: 'https://new.example.test', note: 'Still editable', enabled: false,
  } });
  assert.equal(update.response.status, 200);
  assert.equal(update.data.site.publicUrl, 'https://new.example.test');
  assert.equal(update.data.site.note, 'Still editable');
  assert.equal(update.data.site.enabled, false);
});

test('invalid site update leaves both persisted and in-memory settings unchanged', async () => {
  const initial = await request('/api/sites', { method: 'POST', body: {
    name: 'Transactional settings', slug: 'transactional-site',
    publicUrl: 'https://before.example.test',
  } });
  assert.equal(initial.response.status, 200);
  const result = await request('/api/sites/transactional-site', { method: 'PATCH', body: {
    name: 'Should not persist', publicUrl: 'https://after.example.test', port: 65536,
  } });
  assert.equal(result.response.status, 400);
  const current = await request('/api/sites/transactional-site');
  assert.equal(current.data.site.name, 'Transactional settings');
  assert.equal(current.data.site.publicUrl, 'https://before.example.test');
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'sites.json'), 'utf8'));
  const site = persisted.sites.find(entry => entry.slug === 'transactional-site');
  assert.equal(site.name, 'Transactional settings');
  assert.equal(site.publicUrl, 'https://before.example.test');
});

test('per-site Tailscale API rejects unauthenticated, CSRF and missing-key requests without mutation', async () => {
  let result = await request('/api/sites/transactional-site/tailscale', { session: false });
  assert.equal(result.response.status, 401);
  result = await request('/api/sites/transactional-site/tailscale', {
    method: 'POST', csrf: false, body: { hostname: 'studio' },
  });
  assert.equal(result.response.status, 403);
  result = await request('/api/sites/transactional-site/tailscale', {
    method: 'POST', body: { hostname: 'studio' },
  });
  assert.equal(result.response.status, 400);
  result = await request('/api/sites/transactional-site/tailscale');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.site.tailscale, undefined);
  assert.equal(result.data.site.publicUrl, 'https://before.example.test');
});
