'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { GithubManager } = require('../app/github');

const SECRET = 'github-tests-only-long-and-stable-encryption-secret';
const TOKEN = 'github_pat_TESTONLY0123456789abcdefghijklmnopqrstuvwxyz';
const SOURCE_URL = 'https://github.com/example-owner/example-repo.git';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'WebHafen Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'WebHafen Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    ...options });
}

function write(base, name, text) {
  const destination = path.join(base, ...name.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, text);
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webhafen-github-test-'));
  const source = path.join(root, 'source');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(source);
  fs.mkdirSync(dataDir);
  git(source, ['init', '-b', 'main']);
  const initial = options.files || {
    'web/index.html': '<h1>First release</h1>',
    'web/assets/main.js': 'window.release = 1;',
    'web/old.txt': 'removed in next release',
    'server/private.py': 'server files never belong in the website',
    'README.md': 'project documentation',
  };
  for (const [name, content] of Object.entries(initial)) write(source, name, content);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Initial website']);
  const sites = [{ slug: 'studio', name: 'Studio', type: 'static', enabled: true,
    protected: ['/data'], port: 8011 }];
  const site = sites[0];
  const sitePublic = slug => path.join(dataDir, 'sites', slug, 'public');
  fs.mkdirSync(sitePublic(site.slug), { recursive: true });
  const calls = [];
  let saves = 0;
  const head = () => git(source, ['rev-parse', 'HEAD']).trim();
  const run = async (args, runOptions = {}) => {
    calls.push({ args: [...args], options: { ...runOptions } });
    const rewritten = args.map(arg => arg === SOURCE_URL ? source : arg);
    if (options.beforeRun) {
      const intercepted = await options.beforeRun(args, runOptions);
      if (intercepted !== undefined) return intercepted;
    }
    return new Promise((resolve, reject) => {
      execFile('git', rewritten, { ...runOptions, encoding: null,
        env: { ...process.env, ...runOptions.env, GIT_ALLOW_PROTOCOL: 'file:https',
          GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message)));
        else resolve(stdout);
      });
    });
  };
  const fetch = async input => {
    const url = String(input);
    if (options.fetch) return options.fetch(input);
    if (/\/branches(?:\?|$)/.test(url)) return Response.json([{ name: 'main' }]);
    if (/\/branches\//.test(url)) return Response.json({ name: 'main', commit: { sha: head() } });
    if (/\/commits\//.test(url)) return Response.json({ sha: head(), commit: { message: 'Fixture commit' } });
    if (/\/repos\/example-owner\/example-repo(?:\?|$)/.test(url))
      return Response.json({ name: 'example-repo', full_name: 'example-owner/example-repo', default_branch: 'main' });
    if (/\/repos(?:\?|$)/.test(url)) return Response.json([{ name: 'example-repo', full_name: 'example-owner/example-repo' }]);
    return Response.json({ message: 'Unexpected fixture URL: ' + url }, { status: 404 });
  };
  const manager = new GithubManager({ dataDir, secret: SECRET, getSites: () => sites,
    saveSites: () => { saves++; }, sitePublic, run, fetch,
    onFilesChanged: options.onFilesChanged || (async () => {}) });
  const config = { owner: 'example-owner', repo: 'example-repo', branch: 'main',
    folder: 'web', paths: [], autoCheck: true, autoUpdate: false, intervalMinutes: 15 };
  const commit = message => {
    git(source, ['add', '-A']); git(source, ['commit', '-m', message]); return head();
  };
  t.after(async () => {
    await manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, dataDir, site, sites, manager, config, calls, head, commit,
    publicDir: sitePublic(site.slug), get saves() { return saves; } };
}

async function settled(site) {
  const deadline = Date.now() + 15000;
  while (site.github && site.github.busy) {
    if (Date.now() > deadline) throw new Error('GitHub operation timed out: ' + JSON.stringify(site.github));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return site.github;
}

async function deploy(f, options = {}) {
  const preview = await f.manager.preview(f.site);
  await f.manager.update(f.site, { sha: preview.sha, ...options });
  await settled(f.site);
  return preview;
}

test('configuration has safe defaults and never changes existing website files', async t => {
  const f = fixture(t);
  write(f.publicDir, 'index.html', 'uploaded website');
  await f.manager.configure(f.site, { owner: f.config.owner, repo: f.config.repo, folder: 'web' });
  assert.equal(f.site.github.branch, 'main');
  assert.equal(f.site.github.autoCheck, true);
  assert.equal(f.site.github.autoUpdate, false);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), 'uploaded website');
  assert.equal(f.calls.length, 0);
});

test('invalid owner, repository, branch and selected paths leave configuration unchanged', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  const before = JSON.stringify(f.site.github);
  for (const changes of [
    { owner: '../owner' }, { repo: 'repo;whoami' }, { branch: '--upload-pack=evil' },
    { branch: 'main\nother' }, { folder: '../outside' }, { folder: '/absolute' },
    { paths: ['../../secret'] }, { paths: ['C:\\secret'] },
  ]) {
    await assert.rejects(async () => f.manager.configure(f.site, { ...f.config, ...changes }));
    assert.equal(JSON.stringify(f.site.github), before, JSON.stringify(changes));
  }
});

test('only selected website folder contents are deployed at the public root', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  const preview = await deploy(f);
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  assert.equal(f.site.github.deployedSha, preview.sha);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>First release</h1>');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'assets', 'main.js'), 'utf8'), 'window.release = 1;');
  assert.equal(fs.existsSync(path.join(f.publicDir, 'web')), false);
  assert.equal(fs.existsSync(path.join(f.publicDir, 'server')), false);
  assert.equal(fs.existsSync(path.join(f.publicDir, 'README.md')), false);
  assert.equal(fs.existsSync(path.join(f.publicDir, '.git')), false);
});

test('explicit path selection deploys only chosen files and directories', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, { ...f.config, paths: ['index.html', 'assets'] });
  const preview = await deploy(f);
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  assert.equal(preview.fileCount, 2);
  assert.equal(fs.existsSync(path.join(f.publicDir, 'index.html')), true);
  assert.equal(fs.existsSync(path.join(f.publicDir, 'assets', 'main.js')), true);
  assert.equal(fs.existsSync(path.join(f.publicDir, 'old.txt')), false);
});

test('repository changes outside the selected website do not show a website update', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  const deployedSha = f.site.github.deployedSha;
  write(f.source, 'server/private.py', 'changed only outside website');
  f.commit('Unrelated server change');
  await f.manager.check(f.site);
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  assert.equal(f.site.github.deployedSha, deployedSha);
  write(f.source, 'web/index.html', '<h1>New version</h1>');
  f.commit('Website change');
  await f.manager.check(f.site);
  assert.equal(f.site.github.status, 'update-available', f.site.github.error);
});

test('first deployment requires explicit acknowledgement before replacing uploaded files', async t => {
  const f = fixture(t);
  write(f.publicDir, 'index.html', 'current manually uploaded website');
  write(f.publicDir, 'uploads/photo.txt', 'local runtime data');
  await f.manager.configure(f.site, f.config);
  const preview = await f.manager.preview(f.site);
  assert.ok(preview.existing.includes('index.html'));
  await assert.rejects(async () => f.manager.update(f.site, { sha: preview.sha }));
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), 'current manually uploaded website');
  await f.manager.update(f.site, { sha: preview.sha, overwriteExisting: true });
  await settled(f.site);
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'uploads', 'photo.txt'), 'utf8'), 'local runtime data');
});

test('normal updates remove deleted tracked files and preserve unrelated local files', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  write(f.publicDir, 'uploads/keep.txt', 'persistent local upload');
  write(f.publicDir, 'data/runtime.sqlite', 'runtime database');
  write(f.publicDir, '.env', 'local environment configuration');
  fs.rmSync(path.join(f.source, 'web', 'old.txt'));
  write(f.source, 'web/index.html', '<h1>Second release</h1>');
  f.commit('Remove tracked old file and update website');
  const preview = await deploy(f);
  assert.ok(preview.remove.includes('old.txt'));
  assert.equal(fs.existsSync(path.join(f.publicDir, 'old.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'uploads', 'keep.txt'), 'utf8'), 'persistent local upload');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'data', 'runtime.sqlite'), 'utf8'), 'runtime database');
  assert.equal(fs.readFileSync(path.join(f.publicDir, '.env'), 'utf8'), 'local environment configuration');
});

test('locally modified tracked files are never overwritten even with initial overwrite flag', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  write(f.publicDir, 'index.html', 'edited locally after deployment');
  write(f.source, 'web/index.html', '<h1>Remote update</h1>');
  write(f.source, 'web/assets/main.js', 'window.release = 2;');
  f.commit('Remote website changes');
  const preview = await f.manager.preview(f.site);
  assert.ok(preview.conflicts.includes('index.html'));
  await assert.rejects(async () => f.manager.update(f.site, { sha: preview.sha, overwriteExisting: true }));
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), 'edited locally after deployment');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'assets', 'main.js'), 'utf8'), 'window.release = 1;');
});

test('reviewed preview stays pinned when branch advances before Update', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  const preview = await f.manager.preview(f.site);
  write(f.source, 'web/index.html', '<h1>Not reviewed yet</h1>');
  const newerSha = f.commit('Branch advanced after preview');
  assert.notEqual(preview.sha, newerSha);
  await f.manager.update(f.site, { sha: preview.sha });
  await settled(f.site);
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  assert.equal(f.site.github.deployedSha, preview.sha);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>First release</h1>');
});

test('a failed activation restores website contents and retains deployed revision', async t => {
  let failActivation = false;
  const f = fixture(t, { onFilesChanged: async () => {
    if (failActivation) throw new Error('Test activation failed');
  } });
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  const deployedSha = f.site.github.deployedSha;
  write(f.source, 'web/index.html', '<h1>Will fail activation</h1>');
  f.commit('Failing deployment');
  failActivation = true;
  await deploy(f);
  assert.equal(f.site.github.status, 'error');
  assert.match(f.site.github.error, /activation|failed/i);
  assert.equal(f.site.github.deployedSha, deployedSha);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>First release</h1>');
});

test('rollback restores the previous release and its managed manifest', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  const firstSha = f.site.github.deployedSha;
  write(f.source, 'web/index.html', '<h1>Second release</h1>');
  fs.rmSync(path.join(f.source, 'web', 'old.txt'));
  write(f.source, 'web/new.txt', 'new release file');
  f.commit('Second website release');
  await deploy(f);
  assert.equal(f.site.github.canRollback, true);
  await f.manager.rollback(f.site);
  await settled(f.site);
  assert.equal(f.site.github.deployedSha, firstSha);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>First release</h1>');
  assert.equal(fs.existsSync(path.join(f.publicDir, 'old.txt')), true);
  assert.equal(fs.existsSync(path.join(f.publicDir, 'new.txt')), false);
});

test('private token is encrypted on disk and never written to git argv or site metadata', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, { ...f.config, token: TOKEN });
  await f.manager.check(f.site);
  assert.equal(f.site.github.tokenConfigured, true);
  assert.equal(JSON.stringify(f.site).includes(TOKEN), false);
  assert.equal(JSON.stringify(f.calls.map(call => call.args)).includes(TOKEN), false);
  const encrypted = fs.readFileSync(path.join(f.dataDir, 'github', 'studio', 'token.json'), 'utf8');
  assert.equal(encrypted.includes(TOKEN), false);
  const gitConfigFiles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name === 'config') gitConfigFiles.push(fs.readFileSync(child, 'utf8'));
    }
  }
  walk(path.join(f.dataDir, 'github'));
  assert.equal(gitConfigFiles.join('\n').includes(TOKEN), false);
  assert.doesNotMatch(gitConfigFiles.join('\n'), /authorization|extraheader/i);
  await f.manager.configure(f.site, { ...f.config, removeToken: true });
  assert.equal(f.site.github.tokenConfigured, false);
});

test('selected git symbolic links are rejected before website mutation', async t => {
  const f = fixture(t);
  const blob = git(f.source, ['hash-object', '-w', '--stdin'], { input: '../../outside-sensitive-file' }).trim();
  git(f.source, ['update-index', '--add', '--cacheinfo', '120000,' + blob + ',web/escape']);
  git(f.source, ['commit', '-m', 'Add symbolic link']);
  await f.manager.configure(f.site, f.config);
  await assert.rejects(async () => f.manager.preview(f.site), /symbol|link|verkn|Dateityp/i);
  assert.deepEqual(fs.readdirSync(f.publicDir), []);
});

test('disconnect keeps deployed files and stops automatic update tracking', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  await f.manager.disconnect(f.site);
  assert.equal(f.site.github, undefined);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>First release</h1>');
});

test('external proxy websites cannot deploy repository source into another running server', async t => {
  const f = fixture(t);
  f.site.type = 'proxy';
  await assert.rejects(async () => f.manager.configure(f.site, f.config), /proxy|Weiterleitung|statisch|PHP/i);
  assert.equal(f.site.github, undefined);
});

test('one repository operation locks configuration until it has completed', async t => {
  let releaseFetch;
  let enteredFetch;
  let pauseFetch = false;
  const gate = new Promise(resolve => { releaseFetch = resolve; });
  const entered = new Promise(resolve => { enteredFetch = resolve; });
  const f = fixture(t, { beforeRun: async args => {
    if (pauseFetch && args.includes('fetch')) { enteredFetch(); await gate; }
  } });
  await f.manager.configure(f.site, f.config);
  pauseFetch = true;
  const checking = f.manager.check(f.site);
  await entered;
  try {
    await assert.rejects(async () => f.manager.configure(f.site, { ...f.config, branch: 'other' }),
      error => error.statusCode === 409);
    await assert.rejects(async () => f.manager.disconnect(f.site), error => error.statusCode === 409);
  } finally { releaseFetch(); await checking; }
  assert.equal(f.site.github.branch, 'main');
  assert.equal(f.site.github.busy, false);
});

test('repository secrets, database files and protected folders never replace local runtime data', async t => {
  const f = fixture(t, { files: {
    'web/index.html': '<h1>Safe website</h1>',
    'web/.env': 'REMOTE_SECRET=must-never-deploy',
    'web/.env.production': 'REMOTE_SECRET=also-never-deploy',
    'web/accounts.sqlite': 'repository sqlite must be excluded',
    'web/accounts.sqlite-wal': 'repository sqlite journal must be excluded',
    'web/store.db': 'repository database must be excluded',
    'web/data/private.json': 'protected repository data must be excluded',
  } });
  write(f.publicDir, '.env', 'LOCAL_SECRET=preserve');
  write(f.publicDir, 'accounts.sqlite', 'current runtime database');
  write(f.publicDir, 'data/private.json', 'current protected data');
  await f.manager.configure(f.site, f.config);
  const preview = await deploy(f);
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  assert.equal(fs.readFileSync(path.join(f.publicDir, '.env'), 'utf8'), 'LOCAL_SECRET=preserve');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'accounts.sqlite'), 'utf8'), 'current runtime database');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'data', 'private.json'), 'utf8'), 'current protected data');
  assert.equal(fs.existsSync(path.join(f.publicDir, '.env.production')), false);
  assert.equal(fs.existsSync(path.join(f.publicDir, 'accounts.sqlite-wal')), false);
  assert.equal(fs.existsSync(path.join(f.publicDir, 'store.db')), false);
  assert.ok(Array.isArray(preview.excluded));
  assert.ok(preview.excluded.some(value => String(typeof value === 'string' ? value : value.path).includes('.env')));
});

test('narrowing the selection preserves files outside the new deployment scope', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  await f.manager.configure(f.site, { ...f.config, paths: ['index.html'] });
  write(f.source, 'web/index.html', '<h1>Narrow selection</h1>');
  fs.rmSync(path.join(f.source, 'web', 'old.txt'));
  write(f.source, 'web/assets/main.js', 'window.release = 99;');
  f.commit('Change selected page and unrelated assets');
  const preview = await deploy(f);
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  assert.equal(preview.remove.includes('old.txt'), false);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'old.txt'), 'utf8'), 'removed in next release');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'assets', 'main.js'), 'utf8'), 'window.release = 1;');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>Narrow selection</h1>');
});

test('a linked public root is rejected before accessing files outside the website', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  write(outside, 'index.html', 'outside content must not be replaced');
  fs.rmdirSync(f.publicDir);
  fs.symlinkSync(outside, f.publicDir, process.platform === 'win32' ? 'junction' : 'dir');
  await f.manager.configure(f.site, f.config);
  await assert.rejects(async () => f.manager.preview(f.site), /symbol|link|verkn|Ziel|Website/i);
  assert.equal(fs.readFileSync(path.join(outside, 'index.html'), 'utf8'), 'outside content must not be replaced');
});

test('scheduled checks advertise updates without installing them by default', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  write(f.source, 'web/index.html', '<h1>Scheduled update</h1>');
  f.commit('A version for the next scheduled check');
  f.site.github.checkedAt = 0;
  await f.manager.tick();
  await settled(f.site);
  assert.equal(f.site.github.status, 'update-available', f.site.github.error);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>First release</h1>');
});

test('automatic installation is opt-in and never performs the first deployment', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, { ...f.config, autoUpdate: true });
  await f.manager.tick();
  await settled(f.site);
  assert.equal(f.site.github.status, 'update-available', f.site.github.error);
  assert.deepEqual(fs.readdirSync(f.publicDir), []);
  await deploy(f);
  write(f.source, 'web/index.html', '<h1>Opted in automatic release</h1>');
  const nextSha = f.commit('Automatic update after initial manual deployment');
  f.site.github.checkedAt = 0;
  await f.manager.tick();
  await settled(f.site);
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  assert.equal(f.site.github.deployedSha, nextSha);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>Opted in automatic release</h1>');
});

test('startup journal recovery restores an interrupted deployment before accepting more operations', { timeout: 15000 }, async t => {
  let interruptActivation = false;
  let activationEntered;
  const entered = new Promise(resolve => { activationEntered = resolve; });
  const f = fixture(t, { onFilesChanged: async () => {
    if (interruptActivation) { activationEntered(); await new Promise(() => {}); }
  } });
  await f.manager.configure(f.site, { ...f.config, autoCheck: false });
  await deploy(f);
  const firstSha = f.site.github.deployedSha;
  write(f.source, 'web/index.html', '<h1>Interrupted replacement</h1>');
  write(f.source, 'web/new.txt', 'part of interrupted release');
  f.commit('Release interrupted during activation');
  const preview = await f.manager.preview(f.site);
  interruptActivation = true;
  await f.manager.update(f.site, { sha: preview.sha });
  await entered;
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>Interrupted replacement</h1>');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'github', 'studio', 'pending.json')), true);
  // A new manager mirrors a fresh process reading the saved site metadata.
  const recoveredSite = JSON.parse(JSON.stringify(f.site));
  f.manager.stop();
  const recovered = new GithubManager({ dataDir: f.dataDir, secret: SECRET,
    getSites: () => [recoveredSite], saveSites: () => {}, sitePublic: () => f.publicDir,
    run: async () => { throw new Error('Recovery must not fetch the network'); } });
  t.after(() => recovered.stop());
  recovered.start();
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>First release</h1>');
  assert.equal(fs.existsSync(path.join(f.publicDir, 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'github', 'studio', 'pending.json')), false);
  assert.equal(recoveredSite.github.deployedSha, firstSha);
  assert.equal(recoveredSite.github.busy, false);
  assert.match(recoveredSite.github.error, /unterbrochen|zurückgesetzt|wiederher/i);
});

test('git errors redact raw and encoded access tokens before reaching site status', async t => {
  const encoded = Buffer.from('x-access-token:' + TOKEN).toString('base64');
  const f = fixture(t, { beforeRun: async args => {
    if (args.includes('fetch')) throw new Error('Simulated remote failure ' + TOKEN + ' and ' + encoded);
  } });
  await f.manager.configure(f.site, { ...f.config, token: TOKEN });
  await assert.rejects(async () => f.manager.check(f.site), error => {
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.message.includes(encoded), false);
    return true;
  });
  assert.equal(f.site.github.status, 'error');
  assert.equal(JSON.stringify(f.site).includes(TOKEN), false);
  assert.equal(JSON.stringify(f.site).includes(encoded), false);
});

test('directory browsing remains relative to the chosen website folder', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  const root = await f.manager.tree(f.site, '');
  assert.deepEqual(root.entries.map(entry => entry.name).sort(), ['assets', 'index.html', 'old.txt']);
  const assets = await f.manager.tree(f.site, 'assets');
  assert.deepEqual(assets.entries.map(entry => ({ name: entry.name, path: entry.path, type: entry.type })), [
    { name: 'main.js', path: 'assets/main.js', type: 'file' },
  ]);
  await assert.rejects(async () => f.manager.tree(f.site, '../server'));
});

test('a no-op update keeps the last useful backup and rollback target', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  const firstSha = f.site.github.deployedSha;
  write(f.source, 'web/index.html', '<h1>Second useful release</h1>');
  f.commit('A release worth being able to roll back');
  await deploy(f);
  const stateDir = path.join(f.dataDir, 'github', 'studio');
  const previousBackup = JSON.parse(fs.readFileSync(path.join(stateDir, 'backup.json'), 'utf8'));
  const preview = await deploy(f);
  assert.deepEqual([...preview.add, ...preview.change, ...preview.remove], []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'backup.json'), 'utf8')), previousBackup);
  assert.equal(fs.existsSync(path.join(stateDir, previousBackup.directory, 'snapshot.json')), true);
  assert.equal(f.site.github.canRollback, true);
  await f.manager.rollback(f.site);
  await settled(f.site);
  assert.equal(f.site.github.deployedSha, firstSha);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>First release</h1>');
});

test('identical uploaded files establish a deployed manifest without an empty backup', async t => {
  let activations = 0;
  const f = fixture(t, { onFilesChanged: async () => { activations++; } });
  for (const rel of ['index.html', 'assets/main.js', 'old.txt'])
    write(f.publicDir, rel, fs.readFileSync(path.join(f.source, 'web', ...rel.split('/'))));
  await f.manager.configure(f.site, f.config);
  const preview = await deploy(f);
  assert.deepEqual([...preview.add, ...preview.change, ...preview.remove], []);
  assert.equal(f.site.github.deployedSha, f.head());
  assert.equal(f.site.github.status, 'current', f.site.github.error);
  const stateDir = path.join(f.dataDir, 'github', 'studio');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'deployed.json'), 'utf8')).sha, f.head());
  assert.equal(fs.existsSync(path.join(stateDir, 'backup.json')), false);
  assert.equal(f.site.github.canRollback, false);
  assert.equal(activations, 0);
});

test('a tracked local edit during awaited staging aborts before any update writes', { timeout: 15000 }, async t => {
  let holdStaging = false;
  let enteredStaging;
  let releaseStaging;
  const entered = new Promise(resolve => { enteredStaging = resolve; });
  const gate = new Promise(resolve => { releaseStaging = resolve; });
  const f = fixture(t, { beforeRun: async args => {
    if (holdStaging && args.includes('cat-file')) { enteredStaging(); await gate; }
  } });
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  const firstSha = f.site.github.deployedSha;
  const backupBefore = fs.readFileSync(path.join(f.dataDir, 'github', 'studio', 'backup.json'), 'utf8');
  write(f.source, 'web/index.html', '<h1>Remote update</h1>');
  write(f.source, 'web/assets/main.js', 'window.release = 2;');
  f.commit('Remote changes staged while the website remains active');
  const preview = await f.manager.preview(f.site);
  holdStaging = true;
  await f.manager.update(f.site, { sha: preview.sha });
  await entered;
  try { write(f.publicDir, 'index.html', 'local edit arriving during staging'); }
  finally { releaseStaging(); await settled(f.site); }
  assert.equal(f.site.github.status, 'error');
  assert.match(f.site.github.error, /Lokale|Vorbereitung|Änderung/i);
  assert.equal(f.site.github.deployedSha, firstSha);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), 'local edit arriving during staging');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'assets', 'main.js'), 'utf8'), 'window.release = 1;');
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'github', 'studio', 'backup.json'), 'utf8'), backupBefore);
});

test('rollback refuses newly protected paths without partially restoring other files', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  await deploy(f);
  write(f.source, 'web/index.html', '<h1>Protected rollback target</h1>');
  write(f.source, 'web/assets/main.js', 'window.release = 2;');
  const secondSha = f.commit('Second version of page and assets');
  await deploy(f);
  f.site.protected.push('/assets');
  await assert.rejects(async () => f.manager.rollback(f.site), error => error.statusCode === 409);
  assert.equal(f.site.github.deployedSha, secondSha);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), '<h1>Protected rollback target</h1>');
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'assets', 'main.js'), 'utf8'), 'window.release = 2;');
});

test('a new initial collision after preview is refused even with overwrite acknowledgement', async t => {
  const f = fixture(t);
  await f.manager.configure(f.site, f.config);
  const preview = await f.manager.preview(f.site);
  assert.deepEqual(preview.existing, []);
  write(f.publicDir, 'index.html', 'new local file after the reviewed preview');
  await assert.rejects(async () => f.manager.update(f.site, { sha: preview.sha, overwriteExisting: true }),
    error => error.statusCode === 409);
  assert.equal(fs.readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), 'new local file after the reviewed preview');
  assert.equal(fs.existsSync(path.join(f.publicDir, 'assets')), false);
});
