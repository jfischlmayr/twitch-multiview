// Stand-in for https://player.twitch.tv/js/embed/v1.js, injected before the page loads.
// It mimics the parts of Twitch.Player that Multiview uses and records every call so the
// tests can assert on them. `window.__players[channel]` is the newest player for a channel.
(() => {
  const created = [];
  const players = {};
  window.__created = created;
  window.__players = players;
  window.__fakeLagMs = 0;

  const EVENTS = {
    READY: 'ready', PLAYING: 'playing', PAUSE: 'pause', OFFLINE: 'offline',
    ONLINE: 'online', ENDED: 'ended', PLAYBACK_BLOCKED: 'playbackBlocked',
  };

  class Player {
    constructor(id, options) {
      this.options = options;
      this.channel = options.channel;
      this.muted = Boolean(options.muted);
      this.volume = 1;
      this.calls = [];
      this.listeners = {};
      const host = document.getElementById(id);
      this.iframe = document.createElement('iframe');
      this.iframe.src = 'about:blank';
      host.append(this.iframe);
      created.push(this.channel);
      players[this.channel] = this;
      setTimeout(() => this.emit(EVENTS.READY), 30);
      setTimeout(() => this.emit(EVENTS.PLAYING), 60);
    }

    addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler); }

    emit(event) { (this.listeners[event] ?? []).forEach((handler) => handler()); }

    // Calls take effect after `__fakeLagMs`, like the real cross-frame postMessage bridge.
    later(fn) {
      if (window.__fakeLagMs > 0) setTimeout(fn, window.__fakeLagMs);
      else fn();
    }

    setMuted(value) { this.calls.push({ fn: 'setMuted', value }); this.later(() => { this.muted = value; }); }

    getMuted() { return this.muted; }

    setVolume(value) { this.calls.push({ fn: 'setVolume', value }); this.later(() => { this.volume = value; }); }

    getVolume() { return this.volume; }

    pause() { this.calls.push({ fn: 'pause' }); }

    play() { this.calls.push({ fn: 'play' }); }

    // Test helpers: what the user does inside the Twitch player's own controls.
    nativeSetMuted(value) { this.muted = value; }

    nativeSetVolume(value) { this.volume = value; }
  }
  Object.assign(Player, EVENTS);
  window.Twitch = { Player };
})();
