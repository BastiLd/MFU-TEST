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

test('GitHub configuration and deployment endpoints require authentication and CSRF', async () => {
  const endpoint = '/api/sites/transactional-site/github';
  for (const route of ['', '/repos?owner=example', '/branches', '/tree']) {
    const result = await request(endpoint + route, { session: false });
    assert.equal(result.response.status, 401);
  }
  for (const route of ['', '/check', '/preview', '/update', '/rollback']) {
    const result = await request(endpoint + route, {
      method: route ? 'POST' : 'PUT', csrf: false, body: {},
    });
    assert.equal(result.response.status, 403);
  }
  const current = await request('/api/sites/transactional-site');
  assert.equal(current.data.site.github, undefined);
});

test('saving GitHub settings never uploads files or exposes a private token', async () => {
  const created = await request('/api/sites', { method: 'POST', body: {
    name: 'GitHub website', slug: 'github-site',
  } });
  assert.equal(created.response.status, 200);
  const file = path.join(dataDir, 'sites', 'github-site', 'public', 'index.html');
  const initial = fs.readFileSync(file, 'utf8');
  const token = 'github_pat_testonlyabcdefghijklmnopqrstuvwxyz0123456789';
  const configured = await request('/api/sites/github-site/github', { method: 'PUT', body: {
    owner: 'example', repo: 'website', branch: 'main', folder: 'web/public', paths: ['index.html', 'assets'],
    autoCheck: false, autoUpdate: false, intervalMinutes: 15, token,
  } });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.data));
  assert.equal(configured.data.site.github.owner, 'example');
  assert.equal(configured.data.site.github.folder, 'web/public');
  assert.equal(configured.data.site.github.tokenConfigured, true);
  for (const route of ['/api/sites/github-site/github', '/api/sites', '/api/overview']) {
    const result = await request(route);
    assert.equal(result.response.status, 200);
    assert.equal(JSON.stringify(result.data).includes(token), false);
  }
  assert.equal(fs.readFileSync(path.join(dataDir, 'sites.json'), 'utf8').includes(token), false);
  assert.equal(fs.readFileSync(file, 'utf8'), initial);
  const removed = await request('/api/sites/github-site/github', { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.data.site.github, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), initial);
});

test('invalid GitHub paths and deployment without a preview leave site files untouched', async () => {
  const file = path.join(dataDir, 'sites', 'github-site', 'public', 'index.html');
  const initial = fs.readFileSync(file, 'utf8');
  const result = await request('/api/sites/github-site/github', { method: 'PUT', body: {
    owner: 'example', repo: 'website', branch: 'main', folder: '../outside', autoCheck: false,
  } });
  assert.equal(result.response.status, 400);
  const update = await request('/api/sites/github-site/github/update', { method: 'POST', body: { sha: 'invalid' } });
  assert.ok([400, 409].includes(update.response.status));
  assert.equal(fs.readFileSync(file, 'utf8'), initial);
});

test('deleting a GitHub-linked site removes its token while retaining website files when requested', async () => {
  const configured = await request('/api/sites/github-site/github', { method: 'PUT', body: {
    owner: 'example', repo: 'website', branch: 'main', autoCheck: false,
    token: 'github_pat_testonlyabcdefghijklmnopqrstuvwxyz0123456789',
  } });
  assert.equal(configured.response.status, 200);
  const removed = await request('/api/sites/github-site?files=0', { method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
  assert.equal(fs.existsSync(path.join(dataDir, 'sites', 'github-site', 'public', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'github', 'github-site')), false);
  const archive = path.join(dataDir, 'github', '.removed');
  const retired = fs.readdirSync(archive).find(name => name.startsWith('github-site-'));
  assert.ok(retired);
  assert.equal(fs.existsSync(path.join(archive, retired, 'token.json')), false);
});
