import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHash, buildShareUrl, clampVolume, parseHash, resolveState } from '../assets/url-state.js';

test('parseHash requires a channels parameter', () => {
  assert.equal(parseHash(''), null);
  assert.equal(parseHash('#layout=focus'), null);
  assert.deepEqual(parseHash('#channels=a,b&layout=focus&focus=b&audio=a,b'), {
    channels: ['a', 'b'], layout: 'focus', focus: 'b', audio: ['a', 'b'],
  });
});

test('parseHash sanitises channels and only accepts audio for open streams', () => {
  const parsed = parseHash('#channels=A,b!,c,a&audio=c,zzz,a');
  assert.deepEqual(parsed.channels, ['a', 'c']);
  assert.deepEqual(parsed.audio, ['c', 'a']);
});

test('buildHash and parseHash round-trip', () => {
  const view = { channels: ['a', 'b', 'c'], layout: 'columns', focus: 'c', audio: ['a', 'c'] };
  assert.deepEqual(parseHash(buildHash(view)), view);
  assert.equal(buildHash({ channels: ['a'], layout: 'grid', focus: null }), 'channels=a&layout=grid');
});

test('buildShareUrl appends the hash to the page URL', () => {
  const url = buildShareUrl('https://example.test/app/', { channels: ['a', 'b'], layout: 'grid', focus: 'a', audio: ['b'] });
  assert.equal(url, 'https://example.test/app/#channels=a%2Cb&layout=grid&focus=a&audio=b');
});

test('resolveState prefers the hash over storage but keeps the stored volume', () => {
  const stored = JSON.stringify({ channels: ['x'], layout: 'rows', focus: 'x', volume: 30 });
  const state = resolveState(stored, '#channels=a,b&layout=focus&focus=b&audio=b');
  assert.deepEqual(state, {
    channels: ['a', 'b'], layout: 'focus', focus: 'b', volume: 30, suggestedAudio: ['b'],
  });
});

test('resolveState falls back to storage, then to defaults', () => {
  const stored = JSON.stringify({ channels: ['x', 'y'], layout: 'rows', focus: 'y', volume: '45' });
  assert.deepEqual(resolveState(stored, ''), {
    channels: ['x', 'y'], layout: 'rows', focus: 'y', volume: 45, suggestedAudio: [],
  });
  assert.deepEqual(resolveState(null, ''), {
    channels: [], layout: 'grid', focus: null, volume: 70, suggestedAudio: [],
  });
  assert.deepEqual(resolveState('{not json', '#nonsense'), resolveState(null, ''));
});

test('resolveState validates layout, focus and caps at four streams', () => {
  const stored = JSON.stringify({ channels: ['a', 'b', 'c', 'd', 'e'], layout: 'hax', focus: 'e' });
  const state = resolveState(stored, '');
  assert.deepEqual(state.channels, ['a', 'b', 'c', 'd']);
  assert.equal(state.layout, 'grid');
  assert.equal(state.focus, 'a');
});

test('resolveState never reads audio from storage (autoplay safety)', () => {
  const stored = JSON.stringify({ channels: ['a'], audio: ['a'], layout: 'grid' });
  assert.deepEqual(resolveState(stored, '').suggestedAudio, []);
});

test('clampVolume bounds and rounds', () => {
  assert.equal(clampVolume(-5), 0);
  assert.equal(clampVolume(250), 100);
  assert.equal(clampVolume('33.4'), 33);
  assert.equal(clampVolume('abc'), 70);
});
