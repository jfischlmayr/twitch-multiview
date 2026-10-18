// Persistent view state: URL hash (share links) and localStorage payloads.
import { LAYOUTS, MAX_STREAMS, sanitizeChannels, tryParseChannel } from './channels.js';

export const STORAGE_KEY = 'multiview.twitch.v1';

export const DEFAULT_VOLUME = 70;

export function clampVolume(value) {
  const volume = Number(value);
  return Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : DEFAULT_VOLUME;
}

/**
 * Reads a share-link hash such as `#channels=a,b&layout=focus&focus=b&audio=a,b`.
 * Returns null unless the hash carries a `channels` parameter.
 */
export function parseHash(hash) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  if (!params.has('channels')) return null;
  const channels = sanitizeChannels(params.get('channels').split(','));
  const audio = sanitizeChannels((params.get('audio') ?? '').split(',')).filter((c) => channels.includes(c));
  return {
    channels,
    layout: params.get('layout'),
    focus: tryParseChannel(params.get('focus')),
    audio,
  };
}

/** Serialises view state to a hash string without the leading `#`. */
export function buildHash({ channels, layout, focus, audio = [] }) {
  const params = new URLSearchParams();
  params.set('channels', channels.join(','));
  params.set('layout', layout);
  if (focus) params.set('focus', focus);
  if (audio.length) params.set('audio', audio.join(','));
  return params.toString();
}

/**
 * Merges the stored settings and the URL hash into a normalised view state.
 * The hash wins for channels/layout/focus; volume always comes from storage.
 * `audio` is only ever a *suggestion* (browsers block unmuted autoplay), see audio.js.
 */
export function resolveState(storedJson, hash) {
  let saved = {};
  try {
    saved = JSON.parse(storedJson || '{}') || {};
  } catch {
    saved = {};
  }
  const fromHash = parseHash(hash);
  const source = fromHash ? { ...fromHash, volume: saved.volume } : saved;
  const channels = sanitizeChannels(source.channels, MAX_STREAMS);
  const focus = tryParseChannel(source.focus);
  const volume = ['number', 'string'].includes(typeof source.volume) ? clampVolume(source.volume) : DEFAULT_VOLUME;
  return {
    channels,
    layout: LAYOUTS.includes(source.layout) ? source.layout : 'grid',
    focus: channels.includes(focus) ? focus : channels[0] ?? null,
    volume,
    suggestedAudio: fromHash ? fromHash.audio : [],
  };
}

/** Builds the link shown by the share button. `base` is the page URL without hash. */
export function buildShareUrl(base, view) {
  const url = new URL(base);
  url.hash = buildHash(view);
  return url.toString();
}
