import test from 'node:test';
import assert from 'node:assert/strict';
import { moveChannel, parseChannel, parseInput, planAdd, sanitizeChannels } from '../assets/channels.js';

test('parseChannel accepts bare names, @names and twitch.tv links', () => {
  assert.equal(parseChannel('TwitchDev'), 'twitchdev');
  assert.equal(parseChannel('@some_user'), 'some_user');
  assert.equal(parseChannel('twitch.tv/twitchdev'), 'twitchdev');
  assert.equal(parseChannel('https://www.twitch.tv/TwitchDev'), 'twitchdev');
  assert.equal(parseChannel('http://m.twitch.tv/twitchdev/'), 'twitchdev');
  assert.equal(parseChannel('  https://twitch.tv/twitchdev?foo=1#bar  '), 'twitchdev');
});

test('parseChannel rejects foreign hosts, credentials, ports and sub-pages', () => {
  assert.throws(() => parseChannel('https://evil.example/twitchdev'), /twitch\.tv/);
  assert.throws(() => parseChannel('https://twitch.tv.evil.example/twitchdev'), /twitch\.tv/);
  assert.throws(() => parseChannel('https://user:pw@twitch.tv/twitchdev'), /twitch\.tv/);
  assert.throws(() => parseChannel('https://twitch.tv:8443/twitchdev'), /twitch\.tv/);
  assert.throws(() => parseChannel('ftp://twitch.tv/twitchdev'), /Link|twitch\.tv/);
  assert.throws(() => parseChannel('twitch.tv/videos/12345'), /Clips und Videos/);
  assert.throws(() => parseChannel('twitch.tv/'), /Live-Kanal/);
});

test('parseChannel rejects empty, reserved and malformed names', () => {
  assert.throws(() => parseChannel(''), /eingeben/);
  assert.throws(() => parseChannel(null), /eingeben/);
  assert.throws(() => parseChannel('directory'), /Kanalname/);
  assert.throws(() => parseChannel('twitch.tv/directory'), /Kanalname/);
  assert.throws(() => parseChannel('a'.repeat(26)), /Kanalname/);
  assert.throws(() => parseChannel('bad name!'), /Kanalname/);
  assert.equal(parseChannel('a'.repeat(25)), 'a'.repeat(25));
});

test('parseInput splits on whitespace, commas and semicolons and de-duplicates', () => {
  assert.deepEqual(parseInput('one two,three;\nTwo  twitch.tv/four'), ['one', 'two', 'three', 'four']);
  assert.deepEqual(parseInput('   '), []);
  assert.throws(() => parseInput('ok https://example.com/x'), /twitch\.tv/);
});

test('sanitizeChannels drops invalid entries, duplicates and overflow', () => {
  assert.deepEqual(sanitizeChannels(['a', 'A', 'b!', 'c', 'd', 'e', 'f']), ['a', 'c', 'd', 'e']);
  assert.deepEqual(sanitizeChannels('nope'), []);
  assert.deepEqual(sanitizeChannels(undefined), []);
});

test('planAdd enforces the 4-stream limit and duplicates', () => {
  assert.deepEqual(planAdd([], 'a b'), ['a', 'b']);
  assert.deepEqual(planAdd(['a'], 'a b'), ['b']);
  assert.throws(() => planAdd(['a'], 'a'), /bereits/);
  assert.throws(() => planAdd([], ''), /mindestens/);
  assert.throws(() => planAdd(['a', 'b', 'c'], 'd e'), /Noch 1 Platz frei/);
  assert.throws(() => planAdd(['a', 'b'], 'c d e'), /Noch 2 Plätze frei/);
  assert.deepEqual(planAdd(['a', 'b', 'c'], 'd'), ['d']);
});

test('moveChannel reorders without mutating and clamps at the edges', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(moveChannel(list, 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(moveChannel(list, 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveChannel(list, 'a', 5), ['b', 'c', 'a']);
  assert.deepEqual(moveChannel(list, 'zzz', 1), ['a', 'b', 'c']);
  assert.deepEqual(list, ['a', 'b', 'c']);
});
