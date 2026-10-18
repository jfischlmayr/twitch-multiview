// Tiny Chrome DevTools Protocol driver: just enough to run Multiview end-to-end tests
// without Playwright/Puppeteer. Uses Node's built-in WebSocket client.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const FAKE_TWITCH = readFileSync(new URL('./fake-twitch.js', import.meta.url), 'utf8');
const NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

export function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of NAMES) if (existsSync(join(dir, name))) return join(dir, name);
  }
  const playwright = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(playwright)) {
    const dirs = readdirSync(playwright).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const dir of dirs) {
      const bin = join(playwright, dir, 'chrome-linux64', 'chrome');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

export class Browser {
  static async launch(bin = findChrome()) {
    const profile = await mkdtemp(join(tmpdir(), 'multiview-e2e-'));
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--mute-audio',
      '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ];
    if (process.env.CI || process.getuid?.() === 0) args.unshift('--no-sandbox');
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${log}`)), 20000);
      child.stderr.on('data', (chunk) => {
        log += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on('exit', (code) => reject(new Error(`Chrome exited early (${code}):\n${log}`)));
    });
    const browser = new Browser(child, profile);
    await browser.connect(endpoint);
    return browser;
  }

  constructor(child, profile) {
    this.child = child;
    this.profile = profile;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Map();
  }

  connect(endpoint) {
    this.ws = new WebSocket(endpoint);
    this.ws.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data)));
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  onMessage(message) {
    if (message.id) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter?.resolve(message.result);
    } else if (message.sessionId) {
      this.sessions.get(message.sessionId)?.(message);
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  /** Opens an isolated page (own cookies/localStorage) with the fake Twitch SDK pre-installed. */
  async newPage({ width = 1440, height = 900, fakeTwitch = true } = {}) {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId, browserContextId);
    await page.init({ width, height, fakeTwitch });
    return page;
  }

  async close() {
    try { await this.send('Browser.close'); } catch { /* already closing */ }
    this.ws?.close();
    await new Promise((resolve) => (this.child.exitCode === null ? this.child.once('exit', resolve) : resolve()));
    await rm(this.profile, { recursive: true, force: true });
  }
}

export class Page {
  constructor(browser, sessionId, targetId, contextId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.contextId = contextId;
    this.errors = [];
    this.waiters = [];
    browser.sessions.set(sessionId, (message) => this.onEvent(message));
  }

  async init({ width, height, fakeTwitch }) {
    await this.cmd('Page.enable');
    await this.cmd('Runtime.enable');
    await this.cmd('Log.enable'); // browser-level errors such as CSP violations and failed loads
    await this.setViewport(width, height);
    if (fakeTwitch) await this.cmd('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_TWITCH });
  }

  cmd(method, params) { return this.browser.send(method, params, this.sessionId); }

  onEvent({ method, params }) {
    if (method === 'Runtime.exceptionThrown') this.errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') this.errors.push(params.args.map((a) => a.value ?? a.description).join(' '));
    if (method === 'Log.entryAdded' && params.entry.level === 'error') this.errors.push(`${params.entry.source}: ${params.entry.text}`);
    this.waiters = this.waiters.filter((w) => !(w.method === method && (w.resolve(params), true)));
  }

  once(method) { return new Promise((resolve) => this.waiters.push({ method, resolve })); }

  setViewport(width, height) {
    return this.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async goto(url) {
    const loaded = this.once('Page.loadEventFired');
    await this.cmd('Page.navigate', { url });
    await loaded;
  }

  async reload() {
    const loaded = this.once('Page.loadEventFired');
    await this.cmd('Page.reload');
    await loaded;
  }

  /** Evaluates an expression (or async IIFE) in the page and returns its JSON value. */
  async eval(expression) {
    const result = await this.cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  click(selector) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no element: ' + ${JSON.stringify(selector)}); el.click(); })()`);
  }

  async key(key) {
    const base = { key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, text: key };
    if (key === 'Escape') Object.assign(base, { code: 'Escape', text: undefined });
    await this.cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await this.cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async waitFor(predicateSource, { timeout = 5000, interval = 50 } = {}) {
    const start = Date.now();
    for (;;) {
      if (await this.eval(`Boolean(${predicateSource})`)) return;
      if (Date.now() - start > timeout) throw new Error(`Timed out waiting for: ${predicateSource}`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async close() {
    this.browser.sessions.delete(this.sessionId);
    await this.browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    await this.browser.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {});
  }
}
