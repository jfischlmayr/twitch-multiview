// Twitch Multiview – UI controller.
// Pure logic lives in channels.js, audio.js and url-state.js; this file wires it to the DOM
// and to the Twitch embed player (https://dev.twitch.tv/docs/embed/).
import { LAYOUTS, MAX_STREAMS, moveChannel, planAdd } from './channels.js';
import * as mix from './audio.js';
import { DEFAULT_VOLUME, STORAGE_KEY, buildHash, buildShareUrl, resolveState } from './url-state.js';

const TWITCH_SDK_URL = 'https://player.twitch.tv/js/embed/v1.js';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const MONITOR_INTERVAL_MS = 1000;

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const app = $('app');
const grid = $('streamGrid');
const scroll = $('stageScroll');
const input = $('streamInput');

const state = {
  channels: [],
  layout: 'grid',
  focus: null,
  volume: DEFAULT_VOLUME,
  audio: mix.createAudio(),
  cinema: false,
  sidebarClosed: false,
};

/** One record per open stream: its tile, its Twitch player and UI handles. Keyed by channel. */
const records = new Map();
/** Last time (ms) we sent an audio command to each player; see COMMAND_GRACE_MS in audio.js. */
const commandedAt = new Map();

let sdkPromise = null;
let nextId = 0;
let toastTimer;
let monitorTimer;
let geometryFrame;
let fullscreenWasCinema = false;
let appFullscreenSession = false;

const STATUS_LABELS = {
  loading: 'Lädt',
  ready: 'Bereit',
  playing: 'Läuft',
  paused: 'Pausiert',
  offline: 'Offline',
  blocked: 'Play drücken',
  error: 'Nicht geladen',
  waiting: 'Wartet',
};

const LAYOUT_LABELS = {
  grid: 'Raster',
  focus: 'Fokus',
  columns: 'Nebeneinander',
  rows: 'Untereinander',
};

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function flash(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800);
}

function showError(message) {
  $('formError').textContent = message;
  $('formError').hidden = !message;
  input.setAttribute('aria-invalid', String(!!message));
}

function setIcon(button, name) {
  button.querySelector('use').setAttribute('href', `#i-${name}`);
}

function actionButton(name, title, handler, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button ${extraClass}`.trim();
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = icon(name);
  button.addEventListener('click', handler);
  return button;
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

// ---------------------------------------------------------------------------
// Persistence: localStorage plus (when present) the share-link hash
// ---------------------------------------------------------------------------

/** The selection a share link / reload should offer: what is audible, else what M would restore. */
function audioSelection() {
  return state.audio.active.length ? state.audio.active : state.audio.previous;
}

function viewForUrl() {
  return { channels: state.channels, layout: state.layout, focus: state.focus, audio: audioSelection() };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      channels: state.channels,
      layout: state.layout,
      focus: state.focus,
      volume: state.volume,
    }));
  } catch { /* storage unavailable (private mode, quota) */ }
  try {
    // Only keep the hash in sync when the page was opened from a share link.
    if (new URLSearchParams(location.hash.slice(1)).has('channels')) {
      const url = new URL(location.href);
      url.hash = buildHash(viewForUrl());
      history.replaceState(null, '', url.toString());
    }
  } catch { /* history API unavailable */ }
}

function restore() {
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  const resolved = resolveState(stored, location.hash);
  state.channels = resolved.channels;
  state.layout = resolved.layout;
  state.focus = resolved.focus;
  state.volume = resolved.volume;
  // Browsers block unmuted autoplay, so a suggested selection is only armed for "restore".
  state.audio = mix.createAudio(resolved.suggestedAudio);
}

// ---------------------------------------------------------------------------
// Environment and Twitch SDK
// ---------------------------------------------------------------------------

function environmentIssue() {
  if (location.protocol === 'file:' || !location.hostname) return 'file';
  if (location.protocol !== 'https:' && !LOCAL_HOSTS.includes(location.hostname)) return 'http';
  return null;
}

function showEnvironment() {
  const issue = environmentIssue();
  if (!issue) return;
  const notice = $('environmentNotice');
  notice.hidden = false;
  const heading = document.createElement('strong');
  heading.textContent = issue === 'file' ? 'Zum Abspielen die Webversion öffnen.' : 'Twitch benötigt eine sichere Webadresse.';
  const detail = document.createElement('div');
  detail.textContent = issue === 'file'
    ? 'Die HTML-Datei ist als Datei geöffnet. Für Twitch-Videos brauchst du einen lokalen Webserver (zum Beispiel python3 -m http.server) oder die gehostete Version. Die Anleitung findest du unter Hilfe.'
    : 'Öffne diese Seite über HTTPS oder verwende einen lokalen Webserver unter localhost.';
  notice.append(heading, detail);
}

/** The Twitch embed only runs on HTTPS pages or localhost; `parent` must be the page's hostname. */
function twitchParents() {
  return [location.hostname];
}

function loadSDK() {
  if (window.Twitch?.Player) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TWITCH_SDK_URL;
    script.async = true;
    const fail = (message) => {
      clearTimeout(timer);
      script.remove();
      sdkPromise = null;
      reject(new Error(message));
    };
    const blocked = 'Twitch konnte nicht geladen werden. Prüfe deine Verbindung oder einen Inhaltsblocker.';
    const timer = setTimeout(() => fail(blocked), 15000);
    script.onload = () => {
      if (window.Twitch?.Player) {
        clearTimeout(timer);
        resolve();
      } else {
        fail('Der Twitch-Player ist gerade nicht verfügbar.');
      }
    };
    script.onerror = () => fail(blocked);
    document.head.append(script);
  });
  return sdkPromise;
}

// ---------------------------------------------------------------------------
// Stream tiles and Twitch players
// ---------------------------------------------------------------------------

function setStatus(record, status) {
  if (records.get(record.channel) !== record) return;
  record.status = status;
  record.statusEl.textContent = STATUS_LABELS[status] || status;
  record.statusEl.dataset.status = status;
  const row = $('streamList').querySelector(`[data-channel="${record.channel}"] .stream-state`);
  if (row) row.textContent = STATUS_LABELS[status] || status;
}

function setMessage(record, title, text, canRetry) {
  record.host.hidden = true;
  record.message.hidden = false;
  record.message.replaceChildren();
  const mark = document.createElement('span');
  mark.innerHTML = icon('monitor');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  record.message.append(mark, strong, paragraph);
  if (canRetry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.textContent = 'Erneut versuchen';
    button.onclick = () => reloadPlayer(record.channel);
    record.message.append(button);
  }
}

async function initializePlayer(record) {
  if (environmentIssue()) {
    setStatus(record, 'waiting');
    setMessage(record, `Bereit für ${record.channel}`, 'Öffne Multiview über die Webversion oder localhost, um diesen Stream abzuspielen.', false);
    return;
  }
  try {
    await loadSDK();
    if (records.get(record.channel) !== record) return;
    record.message.hidden = true;
    record.host.hidden = false;
    // Players always start muted so that autoplay is allowed; audio is enabled per stream afterwards.
    record.player = new window.Twitch.Player(record.host.id, {
      width: '100%',
      height: '100%',
      channel: record.channel,
      parent: twitchParents(),
      autoplay: true,
      muted: true,
    });
    const frame = record.host.querySelector('iframe');
    if (frame) {
      frame.title = `Twitch-Stream von ${record.channel}`;
      frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media');
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    }
    const on = (event, handler) => {
      if (!event) return;
      record.player.addEventListener(event, () => {
        if (records.get(record.channel) === record) handler();
      });
    };
    const Player = window.Twitch.Player;
    on(Player.READY, () => {
      record.ready = true;
      clearTimeout(record.timeout);
      setStatus(record, 'ready');
      applyAudio([record.channel]);
    });
    on(Player.PLAYING, () => { record.statusEl.title = ''; setStatus(record, 'playing'); });
    on(Player.PAUSE, () => setStatus(record, 'paused'));
    on(Player.OFFLINE, () => { record.statusEl.title = ''; setStatus(record, 'offline'); });
    on(Player.ENDED, () => setStatus(record, 'offline'));
    on(Player.ONLINE, () => { if (record.status === 'offline') setStatus(record, 'ready'); });
    on(Player.PLAYBACK_BLOCKED, () => {
      setStatus(record, 'blocked');
      record.statusEl.title = 'Autoplay pausiert. Klicke im Twitch-Player auf Play.';
    });
    record.timeout = setTimeout(() => {
      if (!record.ready && records.get(record.channel) === record) {
        setStatus(record, 'waiting');
        record.statusEl.title = 'Lädt länger? Prüfe die Meldung im Player oder lade neu.';
      }
    }, 20000);
  } catch (e) {
    if (records.get(record.channel) !== record) return;
    setStatus(record, 'error');
    setMessage(record, 'Twitch konnte nicht geladen werden', e.message, true);
  }
}

function createRecord(channel) {
  const tile = document.createElement('section');
  tile.className = 'stream-tile';
  tile.dataset.channel = channel;
  tile.setAttribute('aria-label', `Stream ${channel}`);

  const header = document.createElement('div');
  header.className = 'tile-header';
  const index = document.createElement('span');
  index.className = 'tile-index';
  const name = document.createElement('a');
  name.className = 'tile-name';
  name.textContent = channel;
  name.href = `https://www.twitch.tv/${channel}`;
  name.target = '_blank';
  name.rel = 'noopener';
  name.title = `${channel} auf Twitch öffnen`;
  const status = document.createElement('span');
  status.className = 'tile-status';
  status.textContent = STATUS_LABELS.loading;
  status.dataset.status = 'loading';

  const actions = document.createElement('div');
  actions.className = 'tile-actions';
  const audio = actionButton('muted', `Audio von ${channel}`, () => toggleStreamAudio(channel), 'audio-button');
  audio.setAttribute('aria-pressed', 'false');
  const pin = actionButton('pin', `${channel} als Hauptstream`, () => { state.focus = channel; setLayout('focus'); }, 'pin-button');
  pin.setAttribute('aria-pressed', 'false');
  const refresh = actionButton('refresh', `${channel} neu laden`, () => reloadPlayer(channel));
  const remove = actionButton('close', `${channel} entfernen`, () => removeChannel(channel));
  actions.append(audio, pin, refresh, remove);
  header.append(index, name, status, actions);

  const area = document.createElement('div');
  area.className = 'player-area';
  const host = document.createElement('div');
  host.id = `twitch-player-${++nextId}`;
  host.className = 'player-host';
  host.hidden = true;
  const message = document.createElement('div');
  message.className = 'player-message';
  message.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Verbinde mit Twitch …</span>';
  area.append(host, message);
  tile.append(header, area);

  return {
    channel, tile, index, statusEl: status, host, message,
    audioButton: audio, pinButton: pin,
    player: null, ready: false, status: 'loading', timeout: null,
  };
}

function disposeRecord(record) {
  clearTimeout(record.timeout);
  try {
    if (record.ready) {
      record.player.setMuted(true);
      record.player.pause();
    }
  } catch { /* player already gone */ }
  record.tile.remove();
  record.player = null;
}

/** Brings the DOM in line with state.channels. Existing players are kept, never recreated. */
function syncPlayers() {
  for (const [channel, record] of records) {
    if (!state.channels.includes(channel)) {
      records.delete(channel);
      commandedAt.delete(channel);
      disposeRecord(record);
    }
  }
  state.audio = mix.reconcile(state.audio, state.channels);
  for (const channel of state.channels) {
    if (!records.has(channel)) {
      const record = createRecord(channel);
      records.set(channel, record);
      grid.append(record.tile);
      initializePlayer(record);
    }
  }
  // CSS order changes keep existing Twitch iframes connected and playing.
  state.channels.forEach((channel, i) => {
    const record = records.get(channel);
    record.tile.style.order = i;
    record.tile.classList.toggle('grid-last', i === state.channels.length - 1);
    record.index.textContent = String(i + 1).padStart(2, '0');
    record.audioButton.title = `Audio von ${channel} ein-/ausschalten (Taste ${i + 1})`;
  });
  renderList();
  renderLayout();
  renderAudio();
  save();
}

function renderList() {
  const list = $('streamList');
  list.replaceChildren();
  for (let i = 0; i < MAX_STREAMS; i++) {
    const channel = state.channels[i];
    const row = document.createElement('li');
    row.className = `stream-slot${channel ? ' filled' : ''}`;
    if (!channel) {
      row.innerHTML = `<span class="slot-number">0${i + 1}</span><span class="slot-placeholder">Freier Stream-Platz</span>`;
      row.append(actionButton('plus', 'Stream hinzufügen', focusInput, 'slot-add'));
    } else {
      row.dataset.channel = channel;
      const avatar = document.createElement('span');
      avatar.className = 'stream-avatar';
      avatar.textContent = channel.slice(0, 2).toUpperCase();
      const info = document.createElement('div');
      info.className = 'stream-info';
      const name = document.createElement('span');
      name.className = 'stream-name';
      name.textContent = channel;
      const status = document.createElement('span');
      status.className = 'stream-state';
      status.textContent = STATUS_LABELS[records.get(channel)?.status] || STATUS_LABELS.loading;
      info.append(name, status);
      const audio = actionButton('muted', `Audio von ${channel}`, () => toggleStreamAudio(channel), 'list-audio');
      audio.title = `Audio von ${channel} ein-/ausschalten (Taste ${i + 1})`;
      const up = actionButton('up', `${channel} eine Position nach oben`, () => {
        state.channels = moveChannel(state.channels, channel, -1);
        syncPlayers();
      });
      up.disabled = i === 0;
      const remove = actionButton('close', `${channel} entfernen`, () => removeChannel(channel));
      row.append(avatar, info, audio, up, remove);
    }
    list.append(row);
  }
  const full = state.channels.length >= MAX_STREAMS;
  $('streamCount').textContent = `${state.channels.length} / ${MAX_STREAMS}`;
  $('addButton').disabled = full;
  $('addButton').querySelector('span').textContent = full ? `Alle ${MAX_STREAMS} Plätze belegt` : 'Streams hinzufügen';
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function renderLayout() {
  const n = state.channels.length;
  grid.hidden = n === 0;
  $('emptyState').hidden = n > 0;
  grid.dataset.layout = state.layout;
  grid.dataset.count = n;
  grid.style.setProperty('--count', Math.max(n, 1));
  grid.style.setProperty('--side-count', Math.max(n - 1, 1));
  for (const [channel, record] of records) {
    record.tile.classList.toggle('focused', channel === state.focus);
    record.pinButton.setAttribute('aria-pressed', String(channel === state.focus && state.layout === 'focus'));
  }
  document.querySelectorAll('.layout-button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout)));
  $('mobileLayout').value = state.layout;
  $('workspaceTitle').textContent = n ? `${n} ${n === 1 ? 'Stream' : 'Streams'} · ${LAYOUT_LABELS[state.layout]}` : 'Dein Multiview';
  $('workspaceStatus').textContent = n ? 'Alle Perspektiven an einem Ort.' : 'Bereit, wenn du es bist.';
  $('bottomStatus').textContent = n ? 'Twitch-Player · Originales Seitenverhältnis' : 'Ein Platz für alle deine Perspektiven.';
  scheduleGeometry();
}

function scheduleGeometry() {
  cancelAnimationFrame(geometryFrame);
  geometryFrame = requestAnimationFrame(adaptGeometry);
}

function adaptGeometry() {
  if (!state.channels.length) {
    $('resizeNotice').hidden = true;
    return;
  }
  const gutter = state.cinema ? 4 : window.innerWidth <= 700 ? 20 : window.innerWidth <= 1200 ? 32 : 48;
  const available = scroll.clientWidth - gutter;
  const narrowGrid = state.layout === 'grid' && state.channels.length > 1 && available < 810;
  if (narrowGrid) {
    grid.style.gridTemplateColumns = 'minmax(402px,1fr)';
    grid.style.gridTemplateRows = `repeat(${state.channels.length},minmax(334px,1fr))`;
  } else {
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';
  }
  for (const record of records.values()) {
    record.tile.style.gridColumn = narrowGrid ? '1' : '';
    record.tile.style.width = narrowGrid ? '100%' : '';
  }
  const availableHeight = scroll.clientHeight - (state.cinema ? 4 : window.innerWidth <= 700 ? 10 : 20);
  const roomy = state.layout === 'focus' && state.channels.length === 4 && available >= 1218 && availableHeight >= 674;
  grid.dataset.focusArrangement = roomy ? 'bottom' : 'side';
  requestAnimationFrame(() => {
    $('resizeNotice').hidden = scroll.scrollWidth <= scroll.clientWidth + 5 && scroll.scrollHeight <= scroll.clientHeight + 5;
  });
}

function setLayout(layout) {
  if (!LAYOUTS.includes(layout)) return;
  state.layout = layout;
  renderLayout();
  save();
}

// ---------------------------------------------------------------------------
// Adding and removing streams
// ---------------------------------------------------------------------------

function addChannels(value) {
  try {
    const fresh = planAdd(state.channels, value);
    state.channels.push(...fresh);
    if (!state.focus) state.focus = state.channels[0];
    input.value = '';
    showError('');
    syncPlayers();
    if (window.innerWidth <= 700) setMobileStreamsHidden(true);
    flash(`${fresh.length === 1 ? fresh[0] : `${fresh.length} Streams`} hinzugefügt. Audio zunächst stumm.`);
  } catch (e) {
    showError(e.message);
  }
}

function removeChannel(channel) {
  state.channels = state.channels.filter((c) => c !== channel);
  if (state.focus === channel) state.focus = state.channels[0] ?? null;
  state.audio = mix.removeChannel(state.audio, channel);
  showError('');
  syncPlayers();
  if (!state.channels.length) setMobileStreamsHidden(false);
}

function reloadPlayer(channel) {
  const old = records.get(channel);
  if (!old) return;
  records.delete(channel);
  disposeRecord(old);
  syncPlayers();
}

// ---------------------------------------------------------------------------
// Audio: any subset of the open streams can be audible at the same time
// ---------------------------------------------------------------------------

/** Sends the desired mute/volume state to the given players (default: all). Others are left alone. */
function applyAudio(channels = [...records.keys()]) {
  for (const channel of channels) {
    const record = records.get(channel);
    if (!record?.ready) continue;
    commandedAt.set(channel, Date.now());
    try {
      if (state.audio.active.includes(channel)) {
        record.player.setVolume(state.volume / 100);
        record.player.setMuted(state.volume === 0);
      } else {
        record.player.setMuted(true);
      }
    } catch { /* player not ready yet */ }
  }
}

function renderAudio() {
  const summary = mix.summarize(state.audio, state.volume);
  const glyph = (active) => (active && state.volume > 0 ? 'volume' : 'muted');
  for (const [channel, record] of records) {
    const active = state.audio.active.includes(channel);
    record.tile.classList.toggle('audible', active);
    record.audioButton.setAttribute('aria-pressed', String(active));
    setIcon(record.audioButton, glyph(active));
  }
  document.querySelectorAll('.stream-slot.filled').forEach((row) => {
    const active = state.audio.active.includes(row.dataset.channel);
    row.classList.toggle('audible', active);
    const button = row.querySelector('.list-audio');
    button.setAttribute('aria-pressed', String(active));
    setIcon(button, glyph(active));
  });
  $('audioLabel').textContent = summary.label;
  setIcon($('audioIcon'), summary.audible ? 'volume' : 'muted');
  $('muteLabel').textContent = summary.muteLabel;
  $('volumeSlider').value = state.volume;
  $('volumeValue').textContent = `${state.volume} %`;
}

/** Applies a new audio model and pushes only the changed players (plus all, if the volume moved). */
function commitAudio(next, { volumeChanged = false } = {}) {
  const changed = mix.changedChannels(state.audio, next);
  state.audio = next;
  applyAudio(volumeChanged ? [...new Set([...changed, ...next.active])] : changed);
  renderAudio();
  save();
}

/** Nothing is audible at volume 0, so switching a stream on (never off) lifts the slider back up. */
function needsVolumeLift(next) {
  return state.volume === 0 && next.active.length > state.audio.active.length;
}

function toggleStreamAudio(channel) {
  if (!state.channels.includes(channel)) return;
  const next = mix.toggleChannel(state.audio, channel, state.channels);
  const lift = needsVolumeLift(next);
  if (lift) state.volume = DEFAULT_VOLUME;
  commitAudio(next, { volumeChanged: lift });
}

function toggleMute() {
  const next = mix.toggleMuteAll(state.audio, state.channels);
  const lift = needsVolumeLift(next);
  if (lift) state.volume = DEFAULT_VOLUME;
  commitAudio(next, { volumeChanged: lift });
}

function setVolume(value) {
  state.volume = Number(value);
  applyAudio(state.audio.active);
  renderAudio();
  save();
}

/**
 * The Twitch API has no volume-change event, so poll. Native player controls are respected:
 * the monitor only mirrors what the players report and never mutes or unmutes anything.
 */
function monitorAudio() {
  const observed = new Map();
  for (const [channel, record] of records) {
    if (!record.ready) continue;
    try {
      observed.set(channel, { muted: record.player.getMuted(), volume: record.player.getVolume() });
    } catch { /* player not ready */ }
  }
  const result = mix.applyObserved(state.audio, observed, { volume: state.volume, now: Date.now(), commandedAt });
  if (!result.changed) return;
  state.audio = result.audio;
  state.volume = result.volume;
  renderAudio();
  save();
}

function startMonitor() {
  clearInterval(monitorTimer);
  monitorTimer = setInterval(monitorAudio, MONITOR_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Sidebar, cinema mode, fullscreen, sharing
// ---------------------------------------------------------------------------

function setMobileStreamsHidden(hidden) {
  app.classList.toggle('mobile-streams-hidden', hidden);
  $('mobileToggle').setAttribute('aria-expanded', String(!hidden));
}

function focusInput() {
  if (state.cinema) setCinema(false);
  state.sidebarClosed = false;
  app.classList.remove('sidebar-closed', 'mobile-streams-hidden');
  $('sidebarToggle').setAttribute('aria-expanded', 'true');
  $('mobileToggle').setAttribute('aria-expanded', 'true');
  input.focus();
  scheduleGeometry();
}

/** Shared by the mobile and sidebar toggles: shows or hides the stream panel on narrow screens. */
function toggleMobileStreams() {
  const wasDesktopClosed = state.sidebarClosed;
  state.sidebarClosed = false;
  app.classList.remove('sidebar-closed');
  if (wasDesktopClosed) app.classList.remove('mobile-streams-hidden');
  else app.classList.toggle('mobile-streams-hidden');
  return app.classList.contains('mobile-streams-hidden');
}

function toggleSidebar() {
  if (window.innerWidth <= 700) {
    const hidden = toggleMobileStreams();
    $('mobileToggle').setAttribute('aria-expanded', String(!hidden));
    $('sidebarToggle').setAttribute('aria-expanded', String(!hidden));
  } else {
    state.sidebarClosed = !state.sidebarClosed;
    app.classList.toggle('sidebar-closed', state.sidebarClosed);
    $('sidebarToggle').setAttribute('aria-expanded', String(!state.sidebarClosed));
  }
  scheduleGeometry();
}

function setCinema(on) {
  state.cinema = on;
  app.classList.toggle('cinema', on);
  $('cinemaButton').setAttribute('aria-pressed', String(on));
  $('cinemaButton').querySelector('span').textContent = on ? 'Ansicht zurück' : 'Kinomodus';
  $('cinemaButton').title = on ? 'Kinomodus verlassen (T)' : 'Kinomodus (T)';
  scheduleGeometry();
}

function isFullscreen() {
  return document.fullscreenElement === app || document.webkitFullscreenElement === app;
}

async function toggleFullscreen() {
  try {
    if (isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
      return;
    }
    fullscreenWasCinema = state.cinema;
    const request = app.requestFullscreen || app.webkitRequestFullscreen;
    if (!request) {
      setCinema(true);
      flash('Dein Browser unterstützt hier kein Vollbild. Kinomodus ist aktiv.');
      return;
    }
    await request.call(app);
    setCinema(true);
  } catch {
    setCinema(true);
    flash('Vollbild ist hier nicht verfügbar. Kinomodus ist aktiv; öffne die Seite bei Bedarf in einem eigenen Tab.');
  }
}

function fullscreenChanged() {
  const full = isFullscreen();
  $('fullscreenButton').innerHTML = `${icon(full ? 'exit-fullscreen' : 'fullscreen')}<span>${full ? 'Vollbild verlassen' : 'Vollbild'}</span>`;
  $('fullscreenButton').setAttribute('aria-label', full ? 'Vollbild verlassen' : 'Alle Streams im Vollbild');
  if (full) {
    appFullscreenSession = true;
    setCinema(true);
  } else if (appFullscreenSession && !document.fullscreenElement && !document.webkitFullscreenElement) {
    appFullscreenSession = false;
    setCinema(fullscreenWasCinema);
  }
  scheduleGeometry();
}

async function shareView() {
  const text = buildShareUrl(location.href.split('#')[0], viewForUrl());
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    flash('Ansicht-Link kopiert. Kanäle, Layout und Audio-Auswahl sind enthalten.');
  } catch {
    $('shareInput').value = text;
    openDialog($('shareDialog'));
    $('shareInput').focus();
    $('shareInput').select();
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function onKeydown(e) {
  const typing = e.target.closest?.('input,textarea,select,[contenteditable=true]');
  if (e.repeat) return;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || typing || document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  if (key === 'f') {
    e.preventDefault();
    toggleFullscreen();
  } else if (key === 't') {
    e.preventDefault();
    setCinema(!state.cinema);
  } else if (key === 'm') {
    e.preventDefault();
    toggleMute();
  } else if (/^[1-4]$/.test(key)) {
    toggleStreamAudio(state.channels[Number(key) - 1]);
  } else if (key === 'escape' && state.cinema && !isFullscreen()) {
    setCinema(false);
  }
}

function bindEvents() {
  $('addForm').addEventListener('submit', (e) => { e.preventDefault(); addChannels(input.value); });
  input.addEventListener('input', () => showError(''));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      addChannels(input.value);
    }
  });
  document.querySelectorAll('.layout-button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));
  $('mobileLayout').addEventListener('change', (e) => setLayout(e.target.value));
  $('volumeSlider').addEventListener('input', (e) => setVolume(e.target.value));
  $('muteButton').addEventListener('click', toggleMute);
  $('cinemaButton').addEventListener('click', () => setCinema(!state.cinema));
  $('fullscreenButton').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('webkitfullscreenchange', fullscreenChanged);
  $('firstStreamButton').addEventListener('click', focusInput);
  $('sidebarToggle').addEventListener('click', toggleSidebar);
  $('mobileToggle').addEventListener('click', () => {
    if (state.cinema) {
      setCinema(false);
      focusInput();
      return;
    }
    const hidden = toggleMobileStreams();
    $('mobileToggle').setAttribute('aria-expanded', String(!hidden));
    scheduleGeometry();
  });
  $('shareButton').addEventListener('click', shareView);
  $('helpButton').addEventListener('click', () => openDialog($('helpDialog')));
  $('closeHelp').addEventListener('click', () => closeDialog($('helpDialog')));
  $('closeShare').addEventListener('click', () => closeDialog($('shareDialog')));
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) closeDialog(dialog);
  }));
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', scheduleGeometry);
  if (window.ResizeObserver) new ResizeObserver(scheduleGeometry).observe(scroll);

  // Leaving the page silences every player. A restored bfcache page starts muted again,
  // but remembers what was audible so that "restore audio" brings it back.
  window.addEventListener('pagehide', () => {
    clearInterval(monitorTimer);
    for (const record of records.values()) {
      try { if (record.ready) record.player.setMuted(true); } catch { /* ignore */ }
    }
  });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (state.audio.active.length) state.audio = mix.toggleMuteAll(state.audio, state.channels);
    renderAudio();
    startMonitor();
  });
}

function init() {
  app.append($('toast'));
  bindEvents();
  restore();
  showEnvironment();
  syncPlayers();
  startMonitor();
}

init();
