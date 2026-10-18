// End-to-end tests: the real UI in headless Chrome, with a fake Twitch.Player (see fake-twitch.js).
// Run with `npm run test:e2e`. Set CHROME_BIN to pick a browser; set E2E_REQUIRED=1 to fail
// (instead of skip) when no browser is available. Set E2E_BASE_URL (e.g. http://localhost:8080/)
// to test an already running deployment, such as the Docker image with its CSP, instead of the
// built-in static server.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Browser, findChrome } from './browser.mjs';
import { startServer } from '../../scripts/static-server.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const chrome = findChrome();
const skip = !chrome && process.env.E2E_REQUIRED !== '1' ? 'no Chrome/Chromium found (set CHROME_BIN)' : false;

let browser;
let server;

before(async () => {
  if (skip) return;
  assert.ok(chrome, 'E2E_REQUIRED=1 but no Chrome/Chromium found');
  server = process.env.E2E_BASE_URL ? { url: process.env.E2E_BASE_URL, close: async () => {} } : await startServer(ROOT);
  browser = await Browser.launch(chrome);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

/** Runs `body(page)` against a fresh, isolated page and fails on any uncaught page error. */
async function withPage(url, body, options) {
  const page = await browser.newPage(options);
  try {
    await page.goto(server.url + url);
    await body(page);
    assert.deepEqual(page.errors, [], 'page logged errors');
  } finally {
    await page.close();
  }
}

const CHANNELS = ['alpha', 'bravo', 'charlie', 'delta'];
const HASH4 = `#channels=${CHANNELS.join(',')}`;

const tile = (channel) => `.stream-tile[data-channel="${channel}"]`;
const tileAudio = (channel) => `${tile(channel)} .audio-button`;
const listAudio = (channel) => `.stream-slot[data-channel="${channel}"] .list-audio`;

/** Waits until all players fired READY (the fake needs ~30 ms). */
const ready = (page, count) => page.waitFor(`document.querySelectorAll('.stream-tile .tile-status[data-status="playing"]').length === ${count}`);

/** Snapshot of audio-related state as seen by the user (DOM) and by the players. */
const snapshot = (page) => page.eval(`(() => ({
  tiles: Object.fromEntries([...document.querySelectorAll('.audio-button')].map((b) => [b.closest('.stream-tile').dataset.channel, b.getAttribute('aria-pressed') === 'true'])),
  list: Object.fromEntries([...document.querySelectorAll('.list-audio')].map((b) => [b.closest('.stream-slot').dataset.channel, b.getAttribute('aria-pressed') === 'true'])),
  audibleTiles: [...document.querySelectorAll('.stream-tile.audible')].map((t) => t.dataset.channel),
  players: Object.fromEntries(Object.entries(window.__players).map(([c, p]) => [c, { muted: p.muted, volume: p.volume }])),
  label: document.getElementById('audioLabel').textContent,
  muteLabel: document.getElementById('muteLabel').textContent,
  slider: document.getElementById('volumeSlider').value,
}))()`);

const audible = (snap) => Object.entries(snap.tiles).filter(([, on]) => on).map(([c]) => c);
const unmutedPlayers = (snap) => Object.entries(snap.players).filter(([, p]) => !p.muted).map(([c]) => c);
const clearCalls = (page) => page.eval('Object.values(window.__players).forEach((p) => { p.calls.length = 0; })');
const calls = (page) => page.eval('Object.fromEntries(Object.entries(window.__players).map(([c, p]) => [c, p.calls]))');
const muteCalls = (all) => Object.entries(all).filter(([, list]) => list.some((c) => c.fn === 'setMuted' && c.value === true)).map(([c]) => c);

async function open4(page) {
  await page.goto(server.url + HASH4);
  await ready(page, 4);
}

// ---------------------------------------------------------------------------

test('boots into the empty state without errors', { skip }, async () => {
  await withPage('', async (page) => {
    assert.equal(await page.eval('document.title'), 'Multiview — Alle Streams. Ein Bildschirm.');
    assert.equal(await page.eval('document.getElementById("emptyState").hidden'), false);
    assert.equal(await page.eval('document.getElementById("streamGrid").hidden'), true);
    assert.equal(await page.eval('document.getElementById("streamCount").textContent'), '0 / 4');
    assert.equal(await page.eval('document.querySelectorAll(".stream-slot").length'), 4);
  });
});

test('adding streams uses the runtime hostname as Twitch parent and starts muted', { skip }, async () => {
  await withPage('', async (page) => {
    await page.eval(`(() => { const i = document.getElementById('streamInput'); i.value = 'https://www.twitch.tv/Alpha\\nbravo, twitch.tv/charlie delta'; })()`);
    await page.click('#addButton');
    await ready(page, 4);
    assert.deepEqual(await page.eval('window.__created'), CHANNELS);
    const options = await page.eval('Object.values(window.__players).map((p) => p.options)');
    for (const o of options) {
      assert.deepEqual(o.parent, ['localhost']);
      assert.equal(o.muted, true);
      assert.equal(o.autoplay, true);
    }
    const snap = await snapshot(page);
    assert.deepEqual(audible(snap), []);
    assert.deepEqual(unmutedPlayers(snap), []);
    assert.equal(snap.label, 'Alle stumm');
    assert.equal(await page.eval('document.getElementById("addButton").disabled'), true);
    assert.equal(await page.eval('document.getElementById("streamCount").textContent'), '4 / 4');
  });
});

test('invalid input shows an error and adds nothing', { skip }, async () => {
  await withPage('', async (page) => {
    for (const bad of ['https://example.com/foo', 'twitch.tv/videos/123', '!!!']) {
      await page.eval(`document.getElementById('streamInput').value = ${JSON.stringify(bad)}`);
      await page.click('#addButton');
      assert.equal(await page.eval('document.getElementById("formError").hidden'), false, bad);
    }
    assert.equal(await page.eval('document.querySelectorAll(".stream-tile").length'), 0);
    await page.eval(`document.getElementById('streamInput').value = 'a b c d e'`);
    await page.click('#addButton');
    assert.match(await page.eval('document.getElementById("formError").textContent'), /maximal 4/);
  });
});

test('two, three and four streams can be audible at the same time and the monitor never re-mutes them', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    const order = ['bravo', 'delta', 'alpha', 'charlie'];
    for (let n = 1; n <= 4; n++) {
      await page.click(tileAudio(order[n - 1]));
      const expected = order.slice(0, n);
      const snap = await snapshot(page);
      assert.deepEqual(audible(snap).sort(), [...expected].sort(), `tiles after ${n} toggles`);
      assert.deepEqual(Object.entries(snap.list).filter(([, on]) => on).map(([c]) => c).sort(), [...expected].sort(), 'sidebar mirrors tiles');
      assert.deepEqual(snap.audibleTiles.sort(), [...expected].sort());
      assert.deepEqual(unmutedPlayers(snap).sort(), [...expected].sort(), `players after ${n} toggles`);
      for (const c of expected) assert.equal(snap.players[c].volume, 0.7);
      assert.equal(snap.label, n === 1 ? expected[0] : `${n} Streams hörbar`);
      }
    // Let several monitor ticks (1 s) pass beyond the 1.8 s command grace period.
    await clearCalls(page);
    await page.sleep(3600);
    const snap = await snapshot(page);
    assert.deepEqual(unmutedPlayers(snap).sort(), [...CHANNELS].sort(), 'all four still unmuted');
    assert.deepEqual(audible(snap).sort(), [...CHANNELS].sort());
    assert.deepEqual(muteCalls(await calls(page)), [], 'monitor never muted anything');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.close();
  }
});

test('the monitor tolerates players that apply commands late (lag)', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    await page.eval('window.__fakeLagMs = 700');
    for (const c of ['alpha', 'bravo', 'charlie']) await page.click(tileAudio(c));
    await page.sleep(3400);
    const snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'bravo', 'charlie']);
    assert.deepEqual(unmutedPlayers(snap).sort(), ['alpha', 'bravo', 'charlie']);
  } finally {
    await page.close();
  }
});

test('toggling one stream only commands that stream', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    await page.click(tileAudio('alpha'));
    await page.click(listAudio('bravo'));
    await clearCalls(page);
    await page.click(tileAudio('charlie'));
    let all = await calls(page);
    assert.deepEqual(Object.entries(all).filter(([, l]) => l.length).map(([c]) => c), ['charlie']);
    await clearCalls(page);
    await page.click(tileAudio('alpha')); // off again
    all = await calls(page);
    assert.deepEqual(Object.entries(all).filter(([, l]) => l.length).map(([c]) => c), ['alpha']);
    assert.deepEqual(all.alpha, [{ fn: 'setMuted', value: true }]);
    const snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['bravo', 'charlie']);
    assert.deepEqual(unmutedPlayers(snap).sort(), ['bravo', 'charlie']);
  } finally {
    await page.close();
  }
});

test('keys 1-4 toggle each stream independently', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    for (const key of ['1', '3', '4']) await page.key(key);
    let snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'charlie', 'delta']);
    await page.key('3');
    await page.key('2');
    snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'bravo', 'delta']);
    assert.deepEqual(unmutedPlayers(snap).sort(), ['alpha', 'bravo', 'delta']);
    // Auto-repeat of a held key must not flip the stream back and forth.
    await page.eval(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', repeat: true, bubbles: true }))`);
    assert.deepEqual(audible(await snapshot(page)).sort(), ['alpha', 'bravo', 'delta']);
    // A key without a stream behind it is ignored.
    await page.eval(`document.querySelector('${tile('delta')} .tile-actions button:last-child').click()`);
    await page.key('4');
    assert.deepEqual(audible(await snapshot(page)).sort(), ['alpha', 'bravo']);
  } finally {
    await page.close();
  }
});

test('M mutes everything and the second press restores the previous multi-selection', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    for (const c of ['alpha', 'charlie', 'delta']) await page.click(tileAudio(c));
    await page.key('m');
    let snap = await snapshot(page);
    assert.deepEqual(audible(snap), []);
    assert.deepEqual(unmutedPlayers(snap), []);
    assert.equal(snap.label, 'Alle stumm');
    assert.equal(snap.muteLabel, 'Audio wiederherstellen');
    await page.key('m');
    snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'charlie', 'delta']);
    assert.deepEqual(unmutedPlayers(snap).sort(), ['alpha', 'charlie', 'delta']);
    assert.equal(snap.muteLabel, 'Alle stummschalten');
    // The header button behaves like the key.
    await page.click('#muteButton');
    assert.deepEqual(audible(await snapshot(page)), []);
    await page.click('#muteButton');
    assert.deepEqual(audible(await snapshot(page)).sort(), ['alpha', 'charlie', 'delta']);
    // Muted state survives the monitor.
    await page.key('m');
    await page.sleep(2600);
    snap = await snapshot(page);
    assert.deepEqual(audible(snap), []);
    assert.deepEqual(unmutedPlayers(snap), []);
  } finally {
    await page.close();
  }
});

test('the global volume applies to every audible stream and never to muted ones', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    for (const c of ['alpha', 'bravo']) await page.click(tileAudio(c));
    const setSlider = (v) => page.eval(`(() => { const s = document.getElementById('volumeSlider'); s.value = ${v}; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await setSlider(40);
    let snap = await snapshot(page);
    assert.equal(snap.players.alpha.volume, 0.4);
    assert.equal(snap.players.bravo.volume, 0.4);
    assert.equal(snap.players.charlie.muted, true);
    assert.equal(await page.eval('document.getElementById("volumeValue").textContent'), '40 %');
    // Volume 0 silences the players but keeps the selection, and the monitor keeps it.
    await setSlider(0);
    await page.sleep(2300);
    snap = await snapshot(page);
    assert.deepEqual(unmutedPlayers(snap), []);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'bravo']);
    // Switching a stream off at volume 0 must not make the rest audible.
    await page.click(tileAudio('bravo'));
    snap = await snapshot(page);
    assert.equal(snap.slider, '0');
    assert.deepEqual(unmutedPlayers(snap), []);
    await page.click(tileAudio('bravo'));
    // Turning another stream on lifts the volume back up for everyone.
    await page.click(tileAudio('charlie'));
    snap = await snapshot(page);
    assert.equal(snap.slider, '70');
    assert.deepEqual(unmutedPlayers(snap).sort(), ['alpha', 'bravo', 'charlie']);
    assert.equal(snap.players.alpha.volume, 0.7);
    // New audible streams pick up the current volume.
    await setSlider(25);
    await page.click(tileAudio('delta'));
    assert.equal((await snapshot(page)).players.delta.volume, 0.25);
  } finally {
    await page.close();
  }
});

test('native Twitch player controls are respected, not overridden', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    await page.click(tileAudio('alpha'));
    await page.sleep(2000); // past the command grace period
    await clearCalls(page);

    // User unmutes bravo inside its own Twitch UI: it joins the mix, alpha stays audible.
    await page.eval(`window.__players.bravo.nativeSetMuted(false); window.__players.bravo.nativeSetVolume(0.5)`);
    await page.waitFor(`document.querySelector('${tileAudio('bravo')}').getAttribute('aria-pressed') === 'true'`, { timeout: 3000 });
    let snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'bravo']);
    assert.deepEqual(unmutedPlayers(snap).sort(), ['alpha', 'bravo']);
    assert.equal(snap.players.bravo.volume, 0.5, 'native volume left alone');
    assert.deepEqual(muteCalls(await calls(page)), []);

    // ...and mutes alpha natively: only alpha leaves the mix.
    await page.eval(`window.__players.alpha.nativeSetMuted(true)`);
    await page.waitFor(`document.querySelector('${tileAudio('alpha')}').getAttribute('aria-pressed') === 'false'`, { timeout: 3000 });
    snap = await snapshot(page);
    assert.deepEqual(audible(snap), ['bravo']);
    assert.deepEqual(unmutedPlayers(snap), ['bravo']);
    assert.deepEqual(muteCalls(await calls(page)), []);

    // The last audible stream going silent natively arms "restore".
    await page.eval(`window.__players.bravo.nativeSetMuted(true)`);
    await page.waitFor(`document.getElementById('muteLabel').textContent === 'Audio wiederherstellen'`, { timeout: 3000 });
    await page.key('m');
    assert.deepEqual(audible(await snapshot(page)), ['bravo']);
  } finally {
    await page.close();
  }
});

test('removing a stream drops its audio flag and leaves the others playing', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    for (const c of ['alpha', 'bravo', 'charlie']) await page.click(tileAudio(c));
    await clearCalls(page);
    await page.click(`${tile('bravo')} .tile-actions button[aria-label="bravo entfernen"]`);
    let snap = await snapshot(page);
    assert.deepEqual(Object.keys(snap.tiles).sort(), ['alpha', 'charlie', 'delta']);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'charlie']);
    assert.deepEqual(unmutedPlayers(snap).filter((c) => c !== 'bravo').sort(), ['alpha', 'charlie']);
    assert.equal(snap.label, '2 Streams hörbar');
    assert.deepEqual(muteCalls(await calls(page)).filter((c) => c !== 'bravo'), []);

    // Re-adding the same channel does not bring its old audio back.
    await page.eval(`document.getElementById('streamInput').value = 'bravo'`);
    await page.click('#addButton');
    await page.waitFor(`document.querySelectorAll('.stream-tile').length === 4`);
    assert.equal((await snapshot(page)).tiles.bravo, false);
    // ...nor does restore after mute-all.
    await page.key('m');
    await page.key('m');
    snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'charlie']);

    // Removing every audible stream: the global label returns to "all muted".
    for (const c of ['alpha', 'charlie']) await page.click(`${tile(c)} .tile-actions button[aria-label="${c} entfernen"]`);
    snap = await snapshot(page);
    assert.deepEqual(audible(snap), []);
    assert.equal(snap.label, 'Alle stumm');
    assert.equal(snap.muteLabel, 'Alle stumm');
  } finally {
    await page.close();
  }
});

test('reordering, pinning and layout changes keep the same Twitch iframes and the audio mix', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    await page.click(tileAudio('alpha'));
    await page.click(tileAudio('delta'));
    await page.eval(`document.querySelectorAll('.player-host iframe').forEach((f, i) => { f.dataset.marker = 'm' + i; window.__players[f.closest('.stream-tile').dataset.channel].marker = f.dataset.marker; })`);
    const before = await page.eval('JSON.stringify(window.__created)');
    await clearCalls(page);

    for (const layout of ['focus', 'columns', 'rows', 'grid']) {
      await page.click(`.layout-button[data-layout="${layout}"]`);
      assert.equal(await page.eval('document.getElementById("streamGrid").dataset.layout'), layout);
    }
    await page.click(`${tile('charlie')} .pin-button`);
    assert.equal(await page.eval('document.getElementById("streamGrid").dataset.layout'), 'focus');
    assert.equal(await page.eval(`document.querySelector('${tile('charlie')}').classList.contains('focused')`), true);
    await page.click(`.stream-slot[data-channel="delta"] button[aria-label="delta eine Position nach oben"]`);
    await page.click(`.stream-slot[data-channel="delta"] button[aria-label="delta eine Position nach oben"]`);
    assert.equal(await page.eval(`[...document.querySelectorAll('.stream-slot.filled')].map((r) => r.dataset.channel).join()`), 'alpha,delta,bravo,charlie');
    assert.equal(await page.eval(`getComputedStyle(document.querySelector('${tile('delta')}')).order`), '1');
    await page.key('t');
    await page.key('t');

    assert.equal(await page.eval('JSON.stringify(window.__created)'), before, 'no player was recreated');
    const markers = await page.eval(`[...document.querySelectorAll('.player-host iframe')].map((f) => f.dataset.marker).sort().join()`);
    assert.equal(markers, 'm0,m1,m2,m3', 'iframes are the original DOM nodes');
    const snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'delta']);
    assert.deepEqual(unmutedPlayers(snap).sort(), ['alpha', 'delta']);
    assert.deepEqual(await calls(page).then(muteCalls), [], 'no audio commands were sent');
    assert.equal(await page.eval('window.location.hash').then((h) => h.includes('channels')), true);
  } finally {
    await page.close();
  }
});

test('reloading one player re-applies its audio when the new player is ready', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await open4(page);
    await page.click(tileAudio('bravo'));
    await page.click(tileAudio('charlie'));
    await page.click(`${tile('bravo')} button[aria-label="bravo neu laden"]`);
    await page.waitFor(`window.__created.length === 5`);
    await page.waitFor(`window.__players.bravo.muted === false`, { timeout: 3000 });
    const snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['bravo', 'charlie']);
    assert.deepEqual(unmutedPlayers(snap).sort(), ['bravo', 'charlie']);
  } finally {
    await page.close();
  }
});

test('share-link hash: channels, layout, focus; audio is only armed, never autoplayed', { skip }, async () => {
  await withPage('#channels=alpha,bravo,charlie&layout=columns&focus=bravo&audio=alpha,charlie,ghost', async (page) => {
    await ready(page, 3);
    assert.equal(await page.eval('document.getElementById("streamGrid").dataset.layout'), 'columns');
    assert.equal(await page.eval('document.getElementById("streamCount").textContent'), '3 / 4');
    assert.equal(await page.eval(`document.querySelector('${tile('bravo')}').classList.contains('focused')`), true);
    let snap = await snapshot(page);
    assert.deepEqual(audible(snap), []);
    assert.deepEqual(unmutedPlayers(snap), []);
    assert.equal(snap.muteLabel, 'Audio wiederherstellen');
    // The hash keeps the offered selection while everything is muted.
    assert.match(await page.eval('location.hash'), /audio=alpha%2Ccharlie/);
    await page.key('m');
    snap = await snapshot(page);
    assert.deepEqual(audible(snap).sort(), ['alpha', 'charlie']);
    assert.deepEqual(unmutedPlayers(snap).sort(), ['alpha', 'charlie']);
    // Toggling updates the hash; the share dialog contains the same selection.
    await page.key('2');
    assert.match(await page.eval('decodeURIComponent(location.hash)'), /audio=alpha,charlie,bravo/);
    await page.eval(`Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })`);
    await page.click('#shareButton');
    const shared = await page.eval('document.getElementById("shareInput").value');
    assert.match(decodeURIComponent(shared), /#channels=alpha,bravo,charlie&layout=columns&focus=bravo&audio=alpha,charlie,bravo$/);
    assert.equal(new URL(shared).origin, new URL(server.url).origin);
  });
});

test('settings persist across reloads, audio does not', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url);
    await page.eval(`document.getElementById('streamInput').value = 'alpha bravo'`);
    await page.click('#addButton');
    await ready(page, 2);
    await page.click('.layout-button[data-layout="rows"]');
    await page.click(tileAudio('alpha'));
    await page.eval(`(() => { const s = document.getElementById('volumeSlider'); s.value = 35; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await page.reload();
    await ready(page, 2);
    assert.equal(await page.eval('document.getElementById("streamGrid").dataset.layout'), 'rows');
    assert.equal(await page.eval('document.getElementById("volumeSlider").value'), '35');
    const snap = await snapshot(page);
    assert.deepEqual(Object.keys(snap.tiles), ['alpha', 'bravo']);
    assert.deepEqual(audible(snap), []);
    assert.deepEqual(unmutedPlayers(snap), []);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.close();
  }
});

test('accessibility: audio controls expose pressed state and names, status is live', { skip }, async () => {
  await withPage(HASH4, async (page) => {
    await ready(page, 4);
    await page.click(tileAudio('charlie'));
    const info = await page.eval(`[...document.querySelectorAll('.audio-button, .list-audio')].map((b) => ({
      label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), type: b.type, title: b.title,
      channel: (b.closest('[data-channel]')).dataset.channel }))`);
    assert.equal(info.length, 8);
    for (const b of info) {
      assert.equal(b.label, `Audio von ${b.channel}`);
      assert.equal(b.type, 'button');
      assert.match(b.title, /ein-\/ausschalten \(Taste [1-4]\)/);
      assert.equal(b.pressed, b.channel === 'charlie' ? 'true' : 'false');
    }
    assert.equal(await page.eval('document.getElementById("audioLabel").getAttribute("aria-live")'), 'polite');
    assert.equal(await page.eval('document.getElementById("volumeSlider").getAttribute("aria-label")'), 'Lautstärke der hörbaren Streams');
    // The speaker glyph reflects the state.
    assert.equal(await page.eval(`document.querySelector('${tileAudio('charlie')} use').getAttribute('href')`), '#i-volume');
    assert.equal(await page.eval(`document.querySelector('${tileAudio('alpha')} use').getAttribute('href')`), '#i-muted');
  });
});

test('cinema mode and keyboard shortcuts are ignored while typing', { skip }, async () => {
  await withPage(HASH4, async (page) => {
    await ready(page, 4);
    await page.key('t');
    assert.equal(await page.eval('document.getElementById("app").classList.contains("cinema")'), true);
    await page.key('Escape');
    assert.equal(await page.eval('document.getElementById("app").classList.contains("cinema")'), false);
    await page.eval(`document.getElementById('streamInput').focus()`);
    await page.key('1');
    await page.key('m');
    assert.deepEqual(audible(await snapshot(page)), []);
    assert.equal(await page.eval('document.getElementById("streamInput").value'), '1m');
  });
});

test('mobile layout: panel toggles, tiles keep a usable size, audio still works', { skip }, async () => {
  const page = await browser.newPage({ width: 420, height: 800 });
  try {
    await page.goto(server.url + HASH4);
    await ready(page, 4);
    const grid = await page.eval(`(() => { const g = document.getElementById('streamGrid'); return { cols: getComputedStyle(g).gridTemplateColumns.split(' ').length, w: document.querySelector('.stream-tile').getBoundingClientRect().width }; })()`);
    assert.equal(grid.cols, 1);
    assert.ok(grid.w >= 400, `tile width ${grid.w}`);
    assert.equal(await page.eval('getComputedStyle(document.getElementById("mobileToggle")).display !== "none"'), true);
    await page.click('#mobileToggle');
    assert.equal(await page.eval('document.getElementById("app").classList.contains("mobile-streams-hidden")'), true);
    await page.click('#mobileToggle');
    assert.equal(await page.eval('document.getElementById("app").classList.contains("mobile-streams-hidden")'), false);
    await page.click(listAudio('alpha'));
    await page.click(listAudio('delta'));
    assert.deepEqual(audible(await snapshot(page)).sort(), ['alpha', 'delta']);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.close();
  }
});

test('a missing Twitch SDK degrades to a retry message instead of breaking the page', { skip }, async () => {
  const page = await browser.newPage({ fakeTwitch: false });
  try {
    await page.cmd('Fetch.enable', { patterns: [{ urlPattern: 'https://player.twitch.tv/*' }] });
    page.onEvent = ((original) => (message) => {
      if (message.method === 'Fetch.requestPaused') {
        page.cmd('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'Failed' });
      } else {
        original(message);
      }
    })(page.onEvent.bind(page));
    await page.goto(server.url + '#channels=alpha');
    await page.waitFor(`document.querySelector('.player-message .button')`, { timeout: 8000 });
    assert.match(await page.eval('document.querySelector(".player-message strong").textContent'), /Twitch konnte nicht geladen werden/);
    assert.equal(await page.eval('document.querySelector(".tile-status").dataset.status'), 'error');
    // Audio can still be toggled in the UI while the player is unavailable.
    await page.click(tileAudio('alpha'));
    assert.equal(await page.eval(`document.querySelector('${tileAudio('alpha')}').getAttribute('aria-pressed')`), 'true');
  } finally {
    await page.close();
  }
});

test('opened from file:// the page explains how to run it instead of staying blank', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(new URL('index.html', `file://${ROOT}`).href);
    assert.equal(await page.eval('document.getElementById("fileNotice").hidden'), false);
    assert.match(await page.eval('document.getElementById("fileNotice").textContent'), /python3 -m http\.server/);
  } finally {
    await page.close();
  }
});
