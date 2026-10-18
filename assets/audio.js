// Multi-stream audio model. Pure functions, no DOM and no Twitch access.
//
// Shape: { active: string[], previous: string[] }
//   active   channels that are audible right now (any subset of the open streams)
//   previous the selection that was audible before the last "mute all"; the next
//            mute toggle restores it. Also seeded from a share link's `audio=` param.
//
// Every function returns a new object; inputs are never mutated.

/** Grace period (ms) after we commanded a player during which its reported state is not trusted. */
export const COMMAND_GRACE_MS = 1800;

export function createAudio(previous = []) {
  return { active: [], previous: [...previous] };
}

const unique = (list) => [...new Set(list)];

/** Replaces the active set. If it becomes empty, the old set is remembered for restore. */
function commit(audio, next) {
  const active = unique(next);
  const previous = audio.active.length && !active.length ? audio.active.slice() : audio.previous;
  return { active, previous };
}

/** Channels whose audible state differs between two audio objects. */
export function changedChannels(before, after) {
  const all = unique([...before.active, ...after.active]);
  return all.filter((channel) => before.active.includes(channel) !== after.active.includes(channel));
}

/** Toggles a single stream on or off without touching any other stream. */
export function toggleChannel(audio, channel, channels) {
  if (!channels.includes(channel)) return audio;
  const next = audio.active.includes(channel)
    ? audio.active.filter((c) => c !== channel)
    : [...audio.active, channel];
  return commit(audio, next);
}

/**
 * Global mute (key M): mutes everything, or restores the previous selection.
 * With nothing to restore, falls back to the first stream (matches the single-audio behaviour).
 */
export function toggleMuteAll(audio, channels) {
  if (audio.active.length) return commit(audio, []);
  const restored = audio.previous.filter((c) => channels.includes(c));
  const next = restored.length ? restored : channels.slice(0, 1);
  return { active: next, previous: audio.previous };
}

/** Drops a stream everywhere (active and restore memory). */
export function removeChannel(audio, channel) {
  const active = audio.active.filter((c) => c !== channel);
  const previous = audio.previous.filter((c) => c !== channel);
  return { active, previous };
}

/** Removes any channel that is no longer open. */
export function reconcile(audio, channels) {
  return {
    active: audio.active.filter((c) => channels.includes(c)),
    previous: audio.previous.filter((c) => channels.includes(c)),
  };
}

/**
 * Folds the state reported by the Twitch players back into the model, so that
 * native player controls (their own mute/volume UI) are respected.
 *
 * It never mutes anything and never enforces exclusivity: a player that the user
 * unmuted in its own UI is simply added to the active set, and a player that was
 * muted in its own UI is dropped from it.
 *
 * @param audio     current model
 * @param observed  Map<channel, {muted: boolean, volume: 0..1}> for ready players
 * @param opts      { volume: 0..100 slider value, now, commandedAt: Map<channel, ms> }
 * @returns         { audio, volume, changed }
 */
export function applyObserved(audio, observed, { volume, now, commandedAt = new Map() }) {
  let active = audio.active.slice();
  let nextVolume = volume;
  const nativelyAudible = [];

  for (const [channel, state] of observed) {
    if (now - (commandedAt.get(channel) ?? -Infinity) < COMMAND_GRACE_MS) continue;
    const audible = !state.muted && state.volume > 0;
    const isActive = active.includes(channel);
    if (audible) {
      nativelyAudible.push(channel);
      if (!isActive) active.push(channel);
    } else if (isActive && volume > 0) {
      // Slider at 0 means we muted the players ourselves, so that is not a native change.
      active = active.filter((c) => c !== channel);
    }
  }

  // Keep the slider in step when exactly one stream is audible and was adjusted natively.
  if (active.length === 1 && nativelyAudible[0] === active[0]) {
    const reported = Math.round(observed.get(active[0]).volume * 100);
    if (reported !== nextVolume) nextVolume = reported;
  }

  const changed = active.length !== audio.active.length
    || active.some((c) => !audio.active.includes(c))
    || nextVolume !== volume;
  return { audio: changed ? commit(audio, active) : audio, volume: nextVolume, changed };
}

/** Summary for the sidebar and the global mute button. */
export function summarize(audio, volume) {
  const count = audio.active.length;
  const audible = count > 0 && volume > 0;
  let label = 'Alle stumm';
  if (count === 1) label = volume === 0 ? `${audio.active[0]} · 0 %` : audio.active[0];
  else if (count > 1) label = `${count} Streams hörbar`;
  const canRestore = count === 0 && audio.previous.length > 0;
  let muteLabel = 'Alle stumm';
  if (count) muteLabel = 'Alle stummschalten';
  else if (canRestore) muteLabel = 'Audio wiederherstellen';
  return { count, audible, label, muteLabel, allMuted: count === 0 };
}
