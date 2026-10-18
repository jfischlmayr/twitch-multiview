// Static checks: wiring between HTML, CSS and JS, external requests, deploy files and secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const html = read('index.html');
const appJs = read('assets/app.js');
const css = read('assets/styles.css');

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
    const files = out.split('\0').filter(Boolean);
    if (files.length) return files;
  } catch { /* not a git checkout */ }
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    if (['.git', 'node_modules'].includes(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(ROOT, path)];
  });
  return walk(ROOT);
}

test('every element id used by app.js exists in index.html', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size > 20);
  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

test('html ids are unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('every icon reference resolves to a sprite symbol', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="(i-[^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([
    ...[...html.matchAll(/href="#(i-[^"]+)"/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/#i-([a-z-]+)/g)].map((m) => `i-${m[1]}`),
    ...[...appJs.matchAll(/(?:icon|setIcon\([^,]+,|actionButton)\(?'([a-z-]+)'/g)].map((m) => `i-${m[1]}`),
    'i-volume', 'i-muted',
  ]);
  assert.deepEqual([...refs].filter((r) => !symbols.has(r)), []);
});

test('index.html is CSP-friendly: no inline scripts, handlers or style attributes', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="assets\/(app|file-notice)\.js"/);
    assert.equal(body.trim(), '');
  }
  assert.doesNotMatch(html, /<style\b/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
});

test('local assets referenced from index.html and imported by app.js exist', () => {
  for (const [, path] of html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)) assert.ok(existsSync(join(ROOT, path)), path);
  for (const [, path] of appJs.matchAll(/from '\.\/([^']+)'/g)) assert.ok(existsSync(join(ROOT, 'assets', path)), path);
});

test('the only external hosts are Twitch, the SVG namespace and localhost (help text)', () => {
  const sources = { 'index.html': html, 'assets/app.js': appJs, 'assets/styles.css': css };
  // localhost only appears in the help text (how to run locally).
  const allowed = new Set(['www.w3.org', 'player.twitch.tv', 'www.twitch.tv', 'dev.twitch.tv', 'localhost']);
  for (const [name, text] of Object.entries(sources)) {
    for (const [, host] of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      assert.ok(allowed.has(host.toLowerCase()), `${name} references ${host}`);
    }
  }
  assert.match(appJs, /TWITCH_SDK_URL = 'https:\/\/player\.twitch\.tv\/js\/embed\/v1\.js'/);
});

test('the Twitch parent comes from the runtime hostname, not a hard-coded domain', () => {
  assert.match(appJs, /return \[location\.hostname\]/);
  assert.doesNotMatch(appJs, /parent:\s*\[?\s*['"]/);
  assert.doesNotMatch(appJs, /sslip\.io|chatgpt\.site|fishtech/);
});

test('the frontend has no runtime dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.doesNotMatch(appJs, /\bfrom '(?!\.\/)/);
});

test('stylesheet braces are balanced', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"/g, '""');
  const open = (stripped.match(/\{/g) ?? []).length;
  const close = (stripped.match(/\}/g) ?? []).length;
  assert.equal(open, close);
});

test('Dockerfile copies files that exist and serves on port 80', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM nginx:/m);
  assert.match(dockerfile, /^EXPOSE 80$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  for (const [, src] of dockerfile.matchAll(/^COPY\s+(\S+)\s+\S+/gm)) assert.ok(existsSync(join(ROOT, src)), `COPY ${src}`);
  const ignore = read('.dockerignore');
  assert.doesNotMatch(ignore, /^index\.html$|^assets$|^nginx\.conf$/m);
});

test('nginx.conf is balanced, listens on 80 and exposes /healthz', () => {
  const conf = read('nginx.conf');
  assert.equal((conf.match(/\{/g) ?? []).length, (conf.match(/\}/g) ?? []).length);
  assert.match(conf, /listen 80;/);
  assert.match(conf, /location = \/healthz/);
  assert.match(conf, /Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.match(conf, /X-Content-Type-Options "nosniff"/);
});

test('repository hygiene files exist', () => {
  for (const file of ['README.md', 'CONTRIBUTING.md', '.gitignore', '.editorconfig', '.dockerignore', '.github/workflows/check.yml']) {
    assert.ok(existsSync(join(ROOT, file)), file);
  }
  assert.doesNotMatch(read('package.json'), /"license":\s*"(MIT|Apache|GPL|BSD|ISC)/);
  assert.equal(existsSync(join(ROOT, 'LICENSE')), false, 'no license has been chosen yet');
  assert.match(read('README.md'), /No open-source license/i);
});

test('no secrets, tokens or environment files are tracked', () => {
  const files = trackedFiles();
  const forbiddenNames = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|.*\.p12|.*\.log|.*\.png|.*\.jpe?g|.*\.headers)$/i;
  assert.deepEqual(files.filter((f) => forbiddenNames.test(f)), []);
  const patterns = [
    /gh[pousr]_[A-Za-z0-9]{30,}/,
    /github_pat_[A-Za-z0-9_]{30,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /sk-[A-Za-z0-9]{32,}/,
    /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?<!127\.0\.0\.1)(?<!0\.0\.0\.0)/,
  ];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
  }
});
