# Contributing

Thanks for helping to improve Twitch Multiview. This is a small, dependency-free static web app, and the goal is to keep it that way: plain HTML, CSS and ES modules, no build step, no frameworks.

> The repository is currently **private** and has **no open-source license** yet (see the [README](README.md#license-and-status)). Until the owner decides otherwise, contributions are by invitation, and the project stays all rights reserved.

## Getting set up

You need Node.js 22 or newer (for the test runner and the built-in `WebSocket` used by the browser tests) and, for the end-to-end tests, a Chrome or Chromium binary. Nothing is installed with `npm`: there are no dependencies.

```sh
git clone git@github.com:jfischlmayr/twitch-multiview.git
cd twitch-multiview
npm start            # http://localhost:8000/   (or: python3 -m http.server 8000)
```

## Running the checks

| Command | What it does |
| --- | --- |
| `npm run check` | `node --check` on every JavaScript file |
| `npm test` | Unit tests (channel parsing, audio model, URL state) and static checks (HTML/JS wiring, Docker/nginx files, secret scan) |
| `npm run test:e2e` | The real UI in headless Chrome with a fake `Twitch.Player` |
| `npm run test:all` | All of the above |

The end-to-end tests look for Chrome via `CHROME_BIN`, then `PATH` (`google-chrome`, `chromium`, …), then Playwright's cache. Without a browser they are skipped; set `E2E_REQUIRED=1` to make that an error (CI does).

CI (`.github/workflows/check.yml`) runs the same commands plus a Docker build and container smoke test. A pull request should be green before review.

## Project layout

```
index.html            markup, SVG icon sprite, German UI copy
assets/styles.css     all styles
assets/app.js         DOM controller: tiles, Twitch players, events
assets/audio.js       pure audio model (multi-stream mix, mute-all/restore, native-change monitor)
assets/channels.js    pure channel parsing/validation and list helpers
assets/url-state.js   pure share-link (hash) and localStorage handling
tests/                unit + static tests; tests/e2e/ drives Chrome over CDP
scripts/              npm start / syntax check
Dockerfile, nginx.conf  production image
```

Keep logic that can be pure in the pure modules and covered by unit tests; `app.js` should stay a thin layer over them.

## Guidelines

- **No runtime or dev dependencies.** The only external request the app makes is the official Twitch embed script (`https://player.twitch.tv/js/embed/v1.js`). The static tests enforce an allow-list of hosts; adding another one needs a good reason and an update to the CSP in `nginx.conf`.
- **CSP-friendly code.** No inline scripts, no inline event handlers, no `style=""` attributes in HTML. Set styles from CSS or through the CSSOM (`element.style.x = …`).
- **UI copy is German.** The interface (and `lang="de"`) is German; the documentation is English. Keep new strings short and consistent with the existing tone.
- **Accessibility.** Toggle buttons use `aria-pressed` and a stable `aria-label`; state changes that are not otherwise visible go through an `aria-live` region.
- **Twitch rules.** Players always start `muted: true` so that autoplay works, and `parent` is always the runtime `location.hostname`. Never hard-code a domain.
- **Audio changes** must keep these invariants (all covered by tests): any subset of 0–4 streams can be audible; toggling one stream sends commands to that stream only; the monitor never mutes or unmutes anything; removing a stream removes its audio flag; reordering and layout changes never recreate players.
- **Privacy.** No analytics, no third-party requests, no cookies. State lives in `localStorage` and in URLs the user chooses to share.
- **Secrets.** Never commit `.env` files, tokens, keys or screenshots that show personal data. The static tests scan for the common patterns, but they are a safety net, not a review.

## Making a change

1. Branch from `main` (`git switch -c fix/short-description`).
2. Add or update tests first when fixing a bug or changing behaviour.
3. Run `npm run test:all` (and `docker build .` if you touched `Dockerfile` or `nginx.conf`).
4. Use short, imperative commit messages (`Fix restore after removing a stream`); explain the *why* in the body when it is not obvious.
5. Open a pull request against `main` describing the change and how you tested it.

## Testing against the real Twitch player

The automated tests use a fake player so they are deterministic and offline. Before releasing audio-related changes it is worth a manual run against real streams: serve the app over `localhost`, open two or more live channels, switch several on, and confirm they stay audible over a minute or so (the monitor reads the real player state once per second). Browsers may block unmuted playback until you have interacted with the page; click once and try again.
