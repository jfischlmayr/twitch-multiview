# Twitch Multiview

Watch up to **four Twitch streams on one screen**, with flexible layouts and an **audio mixer that lets you listen to any combination of them at the same time**: one stream, two, or all four, each switched on and off independently.

It is a small static website: plain HTML, CSS and ES modules, no framework, no build step, no dependencies. The only third-party code it loads is Twitch's official embed script. The interface is in German; this documentation is in English (a short German summary is at the end).

> **License and status.** This repository is **private** and **no open-source license has been chosen yet**. The code is *all rights reserved* until the owner decides whether to open-source it. Please do not copy, redistribute or make the repository public in the meantime. See [License and status](#license-and-status).

- [Features](#features)
- [Quickstart](#quickstart)
- [Using Multiview](#using-multiview)
- [Audio mixing](#audio-mixing)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Twitch embedding and autoplay limits](#twitch-embedding-and-autoplay-limits)
- [URLs, saved settings and privacy](#urls-saved-settings-and-privacy)
- [Docker](#docker)
- [Deploying with Coolify](#deploying-with-coolify)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Zusammenfassung (Deutsch)](#zusammenfassung-deutsch)
- [Disclaimer](#disclaimer)
- [License and status](#license-and-status)

## Features

- **1–4 streams** from channel names or `twitch.tv` links. Paste several at once, separated by line breaks, spaces or commas.
- **Four layouts:** grid, focus (one main stream plus the others), side by side, and stacked. Switching layouts or reordering streams never reloads a player.
- **Independent audio per stream.** Every stream has its own speaker toggle, on the tile and in the sidebar. Turn on any combination, up to all four. A global volume slider applies to everything that is audible, and **M** mutes all and restores your mix on the next press.
- **Respects Twitch's own controls.** Muting or unmuting inside a Twitch player is picked up by Multiview instead of being fought.
- **Focus, reorder, remove, reload** any stream from its tile or the list. Removing a stream removes its audio selection.
- **Cinema mode and fullscreen** for a distraction-free wall of streams.
- **Share links** that carry channels, layout, focus and (optionally) the audio selection in the URL hash.
- **Saved settings** (channels, layout, volume) in the browser's `localStorage`.
- **Keyboard shortcuts**: `F` fullscreen, `T` cinema, `M` mute all / restore, `1`–`4` toggle each stream's audio.
- **Responsive**, from large desktop screens down to phones, and accessible (`aria-pressed` toggles, labels, live regions, reduced-motion support).
- **Private by design:** no analytics, no cookies, no third-party requests except Twitch itself.

## Quickstart

You need nothing but a static file server. Twitch refuses to play embeds from `file://` pages, so double-clicking `index.html` does not work. Serve the folder over HTTP on `localhost` instead:

```sh
git clone git@github.com:jfischlmayr/twitch-multiview.git
cd twitch-multiview
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open <http://localhost:8000/>. On Windows, use `py -m http.server 8000 --bind 127.0.0.1`.

If you have Node.js 22 or newer, `npm start` does the same (it serves the same folder on port 8000 with correct MIME types).

`localhost` counts as a secure context for Twitch, so plain HTTP works there. For any other hostname the page must be served over **HTTPS**. See [Twitch embedding](#twitch-embedding-and-autoplay-limits).

## Using Multiview

1. Type or paste one or more channel names or links (`twitchdev`, `https://www.twitch.tv/twitchdev`) into the sidebar and press **Enter** or **Streams hinzufügen** (add streams). Up to four fit. Clips and videos are not supported, only live channels.
2. Pick a layout in the top bar. The pin on a tile makes that stream the main one in the focus layout; the arrows in the sidebar list reorder streams.
3. Streams start **muted** (see [autoplay](#twitch-embedding-and-autoplay-limits)). Switch on the speaker of every stream you want to hear.
4. Use **Vollbild** (fullscreen) or **Kinomodus** (cinema mode, which hides the sidebar but keeps the browser chrome) for a full-screen wall.
5. The link button in the top bar copies a share link for the current view.

Layouts that need more room than your window offers scroll instead of shrinking the videos below a usable size (about 400 × 300 px per tile). The grid collapses to one column on narrow windows.

## Audio mixing

Multiview models audio as a **set of audible streams** instead of a single "audio source":

| Action | Result |
| --- | --- |
| Click a stream's speaker (tile or sidebar), or press `1`–`4` | Toggles that stream only. All other streams keep their state; no commands are sent to them. |
| Press `M` or click **Alle stummschalten** | Mutes every stream and remembers the current mix. |
| Press `M` again (button reads **Audio wiederherstellen**) | Restores the remembered mix, including multi-stream selections. Streams removed in the meantime are skipped. With nothing remembered it unmutes the first stream. |
| Volume slider | Sets the volume of every audible stream and is applied to streams you switch on later. At 0 % the mix is kept but silent; switching a stream on lifts the volume back to 70 %. |
| Mute/unmute or change volume inside a Twitch player | Followed, not overridden: a stream you unmute there joins the mix, one you mute there leaves it. The slider follows when exactly one stream is audible. |
| Remove a stream | Its audio flag and its place in the remembered mix are dropped. Adding the same channel again starts muted. |
| Reorder, change layout, pin, cinema mode | Never recreates a player and never changes audio. |
| Reload a single player (circular arrow) | The new player starts muted and re-applies its audio setting as soon as it is ready. |

Twitch's player API has no "volume changed" event, so Multiview polls `getMuted()` / `getVolume()` once per second to notice native changes. The monitor only *reads* and mirrors that state; it never mutes or unmutes a player. After Multiview itself sends a command to a player, that player's reported state is ignored for 1.8 seconds to give the cross-frame message time to land. This logic lives in [`assets/audio.js`](assets/audio.js) and is covered by unit and browser tests, including four simultaneously unmuted players, delayed player responses and native changes.

The selection that **M** would restore is also written to the share link (`audio=…`), so someone opening that link gets a one-press "Audio wiederherstellen". It is never applied automatically, see below.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `F` | Fullscreen for all streams (falls back to cinema mode if the browser refuses) |
| `T` | Cinema mode on/off |
| `M` | Mute all / restore the previous audio selection |
| `1` `2` `3` `4` | Toggle audio for stream 1–4 (in list order) |
| `Esc` | Leave cinema mode (the browser handles leaving fullscreen) |

Shortcuts are ignored while you type in a text field, while a dialog is open, and while a Twitch player has focus (keystrokes inside the iframe belong to Twitch). Click an empty area first if a key seems to do nothing.

## Twitch embedding and autoplay limits

Multiview uses Twitch's [embedded player](https://dev.twitch.tv/docs/embed/). That comes with rules Multiview cannot lift:

- **`parent` and HTTPS.** Twitch only plays an embed when the embedding page's hostname is passed as `parent`. Multiview always uses the actual runtime `location.hostname`, so it works on any domain without configuration, but the page must be served over **HTTPS** (or from `localhost`). A hostname-less `file://` page or plain HTTP on another host shows an explanatory notice instead of players.
- **Referrer.** Twitch requires a referrer. Keep `Referrer-Policy: strict-origin-when-cross-origin` (the app's `<meta>` tag and the bundled nginx config both set it). A stricter policy such as `no-referrer` breaks playback.
- **Autoplay.** Browsers only allow autoplay for muted video, so every player is created with `autoplay: true, muted: true`, and audio is enabled afterwards through the player API in response to your click. After a page reload the browser's autoplay policy applies again and mixes are **not** restored automatically; press `M` (or **Audio wiederherstellen**) or click the speakers. Chrome and Safari may also block unmuting a player that has not received any user interaction yet; the tile then shows **Play drücken**: click play inside the player once.
- **Mobile.** Mobile browsers usually require a tap on the player's play button and may restrict several audible players at once. The multi-stream mix is aimed at desktop browsers.
- **What Twitch controls.** Ads, mature-content gates, sign-in prompts, offline pages, quality selection and the video aspect ratio are handled by Twitch inside the iframe.
- **Not supported:** clips, VODs and collections.

## URLs, saved settings and privacy

**Share links** keep their state in the URL *hash*, which browsers do not send to servers:

```
https://your-host/#channels=alpha,bravo,charlie&layout=focus&focus=bravo&audio=alpha,charlie
```

| Parameter | Meaning |
| --- | --- |
| `channels` | Comma-separated channel names (1–4, validated; invalid or duplicate entries are dropped) |
| `layout` | `grid`, `focus`, `columns` or `rows` |
| `focus` | The main stream for the focus layout (must be one of `channels`) |
| `audio` | The audio selection to offer for restore (a subset of `channels`). Armed, never auto-played |

Links are built from the address you are currently using, so a link copied on `localhost` only works on your own machine; share links from the deployed HTTPS address. If the page was opened from such a link, Multiview keeps the hash in sync while you change things.

**Saved settings:** channels, layout, main stream and volume are stored in `localStorage` under the key `multiview.twitch.v1`. Audio selections are deliberately not stored there.

**Privacy.** Multiview has no backend, analytics, cookies or tracking. Its only network requests are for its own static files and Twitch's embed script and player iframes (`player.twitch.tv`). Twitch then sets whatever cookies and does whatever tracking it normally does for embedded players; read Twitch's privacy notice. If you host Multiview yourself, your web server's access log will contain the usual request metadata (the bundled nginx image logs to stdout/stderr like any nginx container).

The bundled nginx configuration ships a Content Security Policy that allows only the app's own files plus `https://player.twitch.tv` (script and frames).

## Docker

The [`Dockerfile`](Dockerfile) builds a tiny `nginx:alpine` image that serves the site on **port 80** and answers `GET /healthz` with `ok` for health checks.

```sh
docker build -t twitch-multiview .
docker run --rm -p 8080:80 twitch-multiview
```

Open <http://localhost:8080/>. Remember that Twitch only plays on **HTTPS or `localhost`**; for a remote host, put the container behind a TLS-terminating reverse proxy (Traefik, Caddy, nginx, a platform like Coolify, …) with a real domain name.

[`nginx.conf`](nginx.conf) sets `Referrer-Policy`, `X-Content-Type-Options`, a CSP and `Cache-Control: no-cache` (files are not fingerprinted, so browsers revalidate with ETags), and enables gzip. Keep `add_header` directives at server level; a directive inside a `location` block makes nginx drop all inherited ones.

## Deploying with Coolify

[Coolify](https://coolify.io) (v4) can build the image straight from this repository's `Dockerfile`:

1. **Connect the private repository.** Add the GitHub repo as a *Private Repository* source, either with a **GitHub App** or a read-only **deploy key**, and select it.
2. **Create the application** from that repository: branch `main`, build pack **Dockerfile**, Dockerfile location `/Dockerfile`, base directory `/`.
3. **Port:** set *Ports Exposes* to **80**. The container needs no environment variables, volumes or database.
4. **Domain:** under *Domains*, enter your domain with the `https://` scheme (for example `https://multiview.example.com`), and point its DNS `A`/`AAAA` record to the server. Coolify's proxy obtains and renews the Let's Encrypt certificate and terminates TLS, which satisfies Twitch's HTTPS requirement. Coolify can also generate an `sslip.io` hostname with HTTPS if you do not have a domain yet.
5. **Health check:** the image already defines a `HEALTHCHECK` on `/healthz`. If you enable Coolify's own health check, use path `/healthz`, port `80`.
6. **Deploy.** Optionally enable the GitHub webhook / auto-deploy so pushes to `main` redeploy automatically.

After the first deploy, open the HTTPS URL, add a channel, and confirm in the browser's network tab that the Twitch iframe URL contains `parent=<your domain>`. No Multiview setting needs to change when the domain does.

## Development

```sh
npm start            # serve on http://localhost:8000/
npm run check        # syntax-check all JavaScript
npm test             # unit + static tests (Node's built-in runner)
npm run test:e2e     # headless Chrome with a fake Twitch.Player
npm run test:all
```

Requirements: Node.js 22+ and, for the end-to-end tests, Chrome/Chromium (`CHROME_BIN` to point to a specific binary). There is **nothing to install**: the project has no dependencies; the browser tests talk to Chrome over the DevTools protocol with a small driver in `tests/e2e/browser.mjs`.

What the tests cover:

- **Unit:** channel/URL parsing and validation, the 4-stream limit, reordering, share-link and storage handling, the audio model (any combination of streams, per-stream toggle, mute-all/restore, removal, native-change monitor with grace period, summaries).
- **End-to-end:** the real UI with two, three and four simultaneously unmuted streams and a monitor that must never re-mute them (including delayed player responses); toggling via tile, sidebar and keys `1`–`4`; `M` mute/restore; global volume at 40 %/0 %; native Twitch mute/unmute/volume changes; deletion; reordering/pinning/layout switching without recreating iframes; reloading a single player; share-link hashes; persistence across reloads; accessibility attributes; mobile layout; a missing Twitch SDK.
- **Static:** HTML ↔ JS id wiring, icon sprite references, CSP-friendliness (no inline scripts/handlers/styles), external host allow-list, Dockerfile/nginx sanity, and a scan for secrets and forbidden files.

The architecture is deliberately simple: `assets/app.js` is the DOM/Twitch controller, and the logic that matters is in pure, unit-tested modules (`audio.js`, `channels.js`, `url-state.js`). See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

Supported browsers: current evergreen Chrome, Edge, Firefox and Safari (ES modules, `<dialog>`, CSS grid, `:focus-visible`).

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Notice "Zum Abspielen die Webversion öffnen" | You opened `index.html` as a file. Serve it over `localhost` (see [Quickstart](#quickstart)). |
| Notice "Twitch benötigt eine sichere Webadresse" | The page is on plain HTTP with a non-localhost hostname. Use HTTPS. |
| Players stay blank or show a Twitch error about `parent` | The hostname in the address bar is not what Twitch was told. Do not embed Multiview in another page, and do not rewrite hosts through a proxy that hides the original `Host`. |
| "Twitch konnte nicht geladen werden" | A content blocker or firewall blocks `player.twitch.tv`. Allow it and press **Erneut versuchen**. |
| Tile says "Play drücken" | The browser blocked autoplay. Click play inside that player once. |
| A stream you switched on is silent or jumps back to off | The browser blocked unmuted playback before any interaction, or you muted it inside the Twitch player (which Multiview respects). Click the page, then toggle it again. |
| Keys do nothing | Focus is in a text field, a dialog or an iframe. Click an empty area first. |

## Zusammenfassung (Deutsch)

**Twitch Multiview** zeigt bis zu vier Twitch-Streams gleichzeitig an: mit Raster-, Fokus-, Nebeneinander- und Untereinander-Layout, Kino- und Vollbildmodus. Der Ton ist **pro Stream einzeln schaltbar**, es können also beliebig viele der Streams (1–4) gleichzeitig hörbar sein. `M` schaltet alles stumm und beim zweiten Druck die vorherige Auswahl wieder ein, `1`–`4` schalten einzelne Streams. Die Lautstärke gilt für alle hörbaren Streams, und die Twitch-eigenen Regler im Player funktionieren weiterhin.

Starten: `python3 -m http.server 8000 --bind 127.0.0.1`, dann <http://localhost:8000/> öffnen (nicht per `file://`). Betrieb im Internet nur über **HTTPS** mit eigener Domain (Docker/Coolify, Port 80). Alle Streams starten aus Browsergründen stumm; nach dem Neuladen muss der Ton mit `M` bzw. „Audio wiederherstellen“ oder per Klick erneut aktiviert werden. Es gibt keinen Server-Teil, kein Tracking und keine Cookies von Multiview; Einstellungen liegen im `localStorage` des Browsers.

Das Repository ist **privat**; eine Open-Source-Lizenz wurde **noch nicht** gewählt (alle Rechte vorbehalten).

## Disclaimer

Twitch Multiview is an independent project. It is **not affiliated with, endorsed by or sponsored by Twitch Interactive, Inc. or Amazon**. "Twitch" and the Twitch logo are trademarks of Twitch Interactive, Inc. Streams are embedded through Twitch's official player and remain subject to Twitch's [Terms of Service](https://www.twitch.tv/p/legal/terms-of-service/) and [Developer Services Agreement](https://www.twitch.tv/p/legal/developer-agreement/).

## License and status

**No open-source license has been selected.** The repository is private and the source is © 2026 the repository owner, all rights reserved. There is intentionally no `LICENSE` file, and `package.json` is marked `"license": "UNLICENSED"`. The owner will decide later whether to open-source the project and under which license; until then the repository stays private and nothing in it may be reused, redistributed or published without the owner's written permission. If it is ever made public, add a `LICENSE` file, update this section and `package.json`, and update the static test that currently asserts that no license exists.
