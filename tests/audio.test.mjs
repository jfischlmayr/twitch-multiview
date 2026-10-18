import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_GRACE_MS, applyObserved, changedChannels, createAudio, reconcile,
  removeChannel, summarize, toggleChannel, toggleMuteAll,
} from '../assets/audio.js';

const CH = ['a', 'b', 'c', 'd'];

function enable(audio, ...list) {
  return list.reduce((acc, channel) => toggleChannel(acc, channel, CH), audio);
}

test('starts fully muted', () => {
  assert.deepEqual(createAudio(), { active: [], previous: [] });
});

test('any combination of 1-4 streams can be audible at once', () => {
  for (let mask = 1; mask < 16; mask++) {
    const picked = CH.filter((_, i) => mask & (1 << i));
    const audio = enable(createAudio(), ...picked);
    assert.deepEqual([...audio.active].sort(), picked);
  }
  assert.equal(enable(createAudio(), 'a', 'b', 'c', 'd').active.length, 4);
});

test('toggling one stream never touches the others', () => {
  let audio = enable(createAudio(), 'a', 'b', 'c');
  audio = toggleChannel(audio, 'b', CH);
  assert.deepEqual(audio.active, ['a', 'c']);
  audio = toggleChannel(audio, 'd', CH);
  assert.deepEqual(audio.active, ['a', 'c', 'd']);
});

test('toggleChannel ignores unknown channels and does not mutate', () => {
  const audio = enable(createAudio(), 'a');
  const frozen = Object.freeze({ active: Object.freeze([...audio.active]), previous: Object.freeze([]) });
  assert.equal(toggleChannel(frozen, 'zzz', CH), frozen);
  assert.deepEqual(toggleChannel(frozen, 'b', CH).active, ['a', 'b']);
});

test('mute-all remembers the multi-selection and the second press restores it', () => {
  const audio = enable(createAudio(), 'a', 'c', 'd');
  const muted = toggleMuteAll(audio, CH);
  assert.deepEqual(muted.active, []);
  assert.deepEqual(muted.previous, ['a', 'c', 'd']);
  const restored = toggleMuteAll(muted, CH);
  assert.deepEqual(restored.active, ['a', 'c', 'd']);
});

test('mute-all with no history falls back to the first stream', () => {
  assert.deepEqual(toggleMuteAll(createAudio(), CH).active, ['a']);
  assert.deepEqual(toggleMuteAll(createAudio(), []).active, []);
});

test('restore skips streams that were removed in the meantime', () => {
  const muted = toggleMuteAll(enable(createAudio(), 'a', 'b'), CH);
  assert.deepEqual(toggleMuteAll(muted, ['b', 'c']).active, ['b']);
  assert.deepEqual(toggleMuteAll(muted, ['c', 'd']).active, ['c']);
});

test('switching the last audible stream off by hand also arms restore', () => {
  let audio = enable(createAudio(), 'a', 'b');
  audio = toggleChannel(toggleChannel(audio, 'a', CH), 'b', CH);
  assert.deepEqual(audio.active, []);
  assert.deepEqual(audio.previous, ['b']);
  assert.deepEqual(toggleMuteAll(audio, CH).active, ['b']);
});

test('removeChannel clears the stream from active and from restore memory', () => {
  const audio = { active: ['a', 'b'], previous: ['b', 'c'] };
  assert.deepEqual(removeChannel(audio, 'b'), { active: ['a'], previous: ['c'] });
  assert.deepEqual(reconcile(audio, ['a', 'c']), { active: ['a'], previous: ['c'] });
});

test('a seeded selection (share link) is inactive until restored', () => {
  const audio = createAudio(['b', 'c']);
  assert.deepEqual(audio.active, []);
  assert.deepEqual(toggleMuteAll(audio, CH).active, ['b', 'c']);
});

test('changedChannels reports exactly the streams that flipped', () => {
  const before = enable(createAudio(), 'a', 'b');
  const after = enable(createAudio(), 'b', 'c');
  assert.deepEqual(changedChannels(before, after).sort(), ['a', 'c']);
  assert.deepEqual(changedChannels(before, before), []);
});

// --- monitor -------------------------------------------------------------

const NOW = 1_000_000;
const quiet = (extra = {}) => ({ volume: 70, now: NOW, commandedAt: new Map(), ...extra });
const player = (muted, volume = 0.7) => ({ muted, volume });

test('monitor leaves every audible stream alone (2, 3 and 4 unmuted at once)', () => {
  for (const count of [2, 3, 4]) {
    const audio = enable(createAudio(), ...CH.slice(0, count));
    const observed = new Map(CH.map((c, i) => [c, player(i >= count)]));
    const result = applyObserved(audio, observed, quiet());
    assert.equal(result.changed, false);
    assert.equal(result.audio, audio);
    assert.deepEqual(result.audio.active, CH.slice(0, count));
  }
});

test('monitor adds natively unmuted players without muting anything else', () => {
  const audio = enable(createAudio(), 'a');
  const observed = new Map([['a', player(false)], ['b', player(false, 0.5)], ['c', player(true)]]);
  const result = applyObserved(audio, observed, quiet());
  assert.deepEqual(result.audio.active, ['a', 'b']);
  assert.equal(result.changed, true);
  assert.equal(result.volume, 70);
});

test('monitor drops players that were muted in the Twitch UI', () => {
  const audio = enable(createAudio(), 'a', 'b');
  const observed = new Map([['a', player(false)], ['b', player(true)]]);
  const result = applyObserved(audio, observed, quiet());
  assert.deepEqual(result.audio.active, ['a']);
});

test('monitor treats volume 0 in the Twitch UI as muted', () => {
  const audio = enable(createAudio(), 'a', 'b');
  const result = applyObserved(audio, new Map([['a', player(false)], ['b', player(false, 0)]]), quiet());
  assert.deepEqual(result.audio.active, ['a']);
});

test('monitor muting the last stream natively arms restore', () => {
  const audio = enable(createAudio(), 'a');
  const result = applyObserved(audio, new Map([['a', player(true)]]), quiet());
  assert.deepEqual(result.audio, { active: [], previous: ['a'] });
});

test('monitor ignores players we commanded within the grace window', () => {
  const audio = enable(createAudio(), 'a', 'b');
  const commandedAt = new Map([['a', NOW - 100], ['b', NOW - COMMAND_GRACE_MS - 1]]);
  // 'a' still reports muted (command not applied yet) and must not be dropped; 'b' is stale -> dropped.
  const observed = new Map([['a', player(true)], ['b', player(true)], ['c', player(false)]]);
  const result = applyObserved(audio, observed, quiet({ commandedAt: commandedAt.set('c', NOW - 50) }));
  assert.deepEqual(result.audio.active, ['a']);
});

test('monitor does not deactivate muted players while the slider is at 0', () => {
  const audio = enable(createAudio(), 'a', 'b');
  const observed = new Map([['a', player(true, 0)], ['b', player(true, 0)]]);
  const result = applyObserved(audio, observed, quiet({ volume: 0 }));
  assert.equal(result.changed, false);
  assert.deepEqual(result.audio.active, ['a', 'b']);
});

test('monitor mirrors a native volume change only when exactly one stream is audible', () => {
  const single = applyObserved(enable(createAudio(), 'a'), new Map([['a', player(false, 0.25)]]), quiet());
  assert.equal(single.volume, 25);
  const multi = applyObserved(enable(createAudio(), 'a', 'b'), new Map([['a', player(false, 0.25)], ['b', player(false, 0.7)]]), quiet());
  assert.equal(multi.volume, 70);
  assert.equal(multi.changed, false);
});

test('monitor ignores players that are not ready (absent from the map)', () => {
  const audio = enable(createAudio(), 'a', 'b');
  const result = applyObserved(audio, new Map([['a', player(false)]]), quiet());
  assert.deepEqual(result.audio.active, ['a', 'b']);
});

// --- summary -------------------------------------------------------------

test('summarize drives the sidebar and the global button', () => {
  assert.deepEqual(summarize(createAudio(), 70), {
    count: 0, audible: false, label: 'Alle stumm', muteLabel: 'Alle stumm', allMuted: true,
  });
  assert.equal(summarize(createAudio(['a']), 70).muteLabel, 'Audio wiederherstellen');
  assert.equal(summarize(enable(createAudio(), 'a'), 70).label, 'a');
  assert.equal(summarize(enable(createAudio(), 'a'), 0).label, 'a · 0 %');
  const many = summarize(enable(createAudio(), 'a', 'b', 'c'), 70);
  assert.equal(many.label, '3 Streams hörbar');
  assert.equal(many.muteLabel, 'Alle stummschalten');
  assert.equal(many.allMuted, false);
  assert.equal(summarize(enable(createAudio(), 'a', 'b'), 0).audible, false);
});
