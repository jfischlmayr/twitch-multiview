// Channel parsing and stream-list helpers. Pure functions, no DOM access.

export const MAX_STREAMS = 4;

export const LAYOUTS = ['grid', 'focus', 'columns', 'rows'];

// Top-level twitch.tv paths that are pages, not channels.
const RESERVED = new Set([
  'directory', 'videos', 'downloads', 'settings', 'subscriptions', 'inventory', 'wallet',
  'search', 'login', 'signup', 'logout', 'turbo', 'jobs', 'p', 'store', 'drops', 'friends',
  'messages', 'moderator', 'dashboard', 'broadcast', 'collections', 'clip', 'clips', 'about',
]);

const TWITCH_HOSTS = ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'];

/**
 * Turns a channel name or a twitch.tv link into a normalised channel login.
 * Throws an Error with a user-facing (German) message when the value is invalid.
 */
export function parseChannel(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('Bitte einen Twitch-Link oder Kanalnamen eingeben.');
  let channel = value.replace(/^@/, '');
  if (/[/.:?#]/.test(value)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw new Error('Der Link ist ungültig. Verwende twitch.tv/kanalname.');
    }
    const hostOk = TWITCH_HOSTS.includes(url.hostname.toLowerCase());
    if (!['http:', 'https:'].includes(url.protocol) || !hostOk || url.username || url.password || url.port) {
      throw new Error('Bitte einen Kanal-Link von twitch.tv verwenden.');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) {
      throw new Error('Bitte einen Live-Kanal verlinken, zum Beispiel twitch.tv/kanalname. Clips und Videos werden nicht unterstützt.');
    }
    channel = parts[0];
  }
  channel = channel.toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(channel) || RESERVED.has(channel)) {
    throw new Error('Kein gültiger Kanalname. Erlaubt sind bis zu 25 Buchstaben, Zahlen und Unterstriche.');
  }
  return channel;
}

/** Parses several channels separated by whitespace, commas or semicolons; duplicates are dropped. */
export function parseInput(value) {
  return [...new Set(String(value ?? '').trim().split(/[\s,;]+/).filter(Boolean).map(parseChannel))];
}

/** Like parseChannel, but returns null instead of throwing. */
export function tryParseChannel(raw) {
  try {
    return parseChannel(raw);
  } catch {
    return null;
  }
}

/** Validates and de-duplicates a list of untrusted channel values, capped at `max`. */
export function sanitizeChannels(values, max = MAX_STREAMS) {
  const out = [];
  if (!Array.isArray(values)) return out;
  for (const value of values) {
    if (out.length >= max) break;
    const channel = tryParseChannel(value);
    if (channel && !out.includes(channel)) out.push(channel);
  }
  return out;
}

/**
 * Validates a form submission against the current list.
 * Returns the new channels (in input order) or throws a user-facing Error.
 */
export function planAdd(current, value, max = MAX_STREAMS) {
  const parsed = parseInput(value);
  if (!parsed.length) throw new Error('Füge mindestens einen Twitch-Link oder Kanalnamen ein.');
  const fresh = parsed.filter((channel) => !current.includes(channel));
  if (!fresh.length) throw new Error('Diese Kanäle sind bereits in deinem Multiview.');
  const free = max - current.length;
  if (fresh.length > free) {
    throw new Error(`Es passen maximal ${max} Streams in die Ansicht. Noch ${free} ${free === 1 ? 'Platz' : 'Plätze'} frei.`);
  }
  return fresh;
}

/** Returns a copy of `channels` with `channel` moved by `delta` positions (clamped). */
export function moveChannel(channels, channel, delta) {
  const from = channels.indexOf(channel);
  if (from < 0) return channels.slice();
  const to = Math.max(0, Math.min(channels.length - 1, from + delta));
  const next = channels.slice();
  next.splice(from, 1);
  next.splice(to, 0, channel);
  return next;
}
