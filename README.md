# octos-web

The web client for [octos](https://github.com/octos-org/octos) — a React SPA that talks to an `octos serve` backend over **UI Protocol v1** (JSON-RPC over WebSocket). Chat with your agent, talk to it by voice or video, build slide decks and sites with it, and administer the whole server — from a browser.

octos-web is one of two first-party clients for the octos server; the other is [octos-tui](https://github.com/octos-org/octos-tui) for the terminal. Both speak the same protocol.

**Stack:** React 19 · TypeScript · Vite 7 · Tailwind CSS 4 · react-router 7 · Vitest + Playwright.

## Surfaces

| Route | What it is |
|---|---|
| `/` | Project launcher — every chat, deck, and site as a project card (Ivory Obsidian design system) |
| `/home` | Home-assistant standby — clock, weather/news/calendar/photo/smart-home widgets, night mode, wake-word |
| `/voice` | Voice assistant — on-device VAD, streamed TTS with barge-in, user-selectable voices, live video chat |
| `/chat` | The chat workbench — streaming turns, tool activity, approvals, file uploads, rich media |
| `/studio/:projectId` | Studio — three-pane grounded workspace (sources · chat · skills) pinned to a project session |
| `/slides`, `/slides/:id/present` | Slide-deck gallery, editor, and full-screen present mode |
| `/sites`, `/sites/:id` | Generated-site gallery and editor with signed previews |
| `/settings` | Admin dashboard — LLM providers & failover, users, channels, sandbox, tools, system metrics & live logs, server watchdog, skills hub, voice, appearance |
| `/login` | Email-code login, or password-free solo login against `octos serve --solo` |

## Quickstart

Prereqs: Node 20+, and an octos server.

```bash
# 1. Run the backend on :50080 (from the octos repo)
octos serve                 # or: octos serve --solo   (password-free local login)

# 2. Run the web client
npm ci
npm run dev                 # Vite dev server on http://localhost:5173
```

The dev server proxies `/api` (including the WebSocket upgrade) to `http://localhost:50080`, so the app is same-origin out of the box. Sign in with an email code, or one click on the solo button when the server runs `--solo`.

`predev` copies the VAD/onnx wasm assets (`scripts/copy-vad-assets.mjs`) — it runs automatically before `dev` and `build`.

## Build, lint, test

```bash
npm run build          # tsc -b && vite build  → dist/
npm run preview        # serve the production build locally
npm run lint           # eslint

npm run test:unit      # Vitest unit suite (~800 tests, jsdom, no server needed)
npm test               # Playwright e2e — needs the app + a LIVE octos server
npm run test:live:smoke   # fast live smoke subset
npm run test:live:long    # long-running live scenarios (deep research, TTS)
```

The unit suite is the merge gate. Playwright specs (in `tests/`) drive a real browser against `http://localhost:5174` and exercise live server behavior — run them when touching transport, voice, or session flows.

## How it connects

- **Transport** — `src/runtime/ui-protocol-bridge.ts`: a strict, fail-closed JSON-RPC bridge over WebSocket at `/api/ui-protocol/ws`. Reconnects with exponential backoff, resumes with an `after` cursor + `session/hydrate`, and queues outbound RPCs while offline. This is the *only* chat transport (the legacy SSE/REST bridge is gone).
- **Events → state** — `src/runtime/ui-protocol-event-router.ts` routes typed notifications (`message/delta`, `message/persisted`, `turn/spawn_complete`, `tool/*`, approvals, …) into `src/store/thread-store.ts`, the single source of truth keyed by `client_message_id`. A pure projection layer (`src/store/projection.ts`, envelopes → view-model) runs behind the `octos_projection_v1` flag.
- **Auth** — session token (`octos_session_token`) and optional admin token in localStorage; the WS handshake carries the token as a query parameter.

The protocol contract lives in the octos repo (`crates/octos-core/src/ui_protocol.rs` and the API docs). Server merges do not wait for client releases — the spec is the contract.

## Configuration

| Env var | Purpose |
|---|---|
| `BASE_URL` | Vite base path for subpath deploys (e.g. `/octos-web/`) |
| `VITE_SKIP_AUTH` | Skip the auth guard — static/demo deploys only |
| `VITE_PUBLIC_API_ORIGIN` | Absolute API origin when not same-origin |
| `VITE_WEBHOOK_ORIGIN` | Origin shown for channel webhook URLs |
| `VITE_SMART_HOME_API_BASE` | Smart-home widget backend (dev proxy: `/smart-home-api` → `:8787`) |

## Deploying

- **Static canary** — `.github/workflows/deploy.yml` publishes the app to GitHub Pages (`BASE_URL=/octos-web/`, SPA `404.html` fallback) with auth skipped, plus the `book/` mdBook of sample research reports under `/book`.
- **Production** — build with `npm run build` and serve `dist/` from any static host or reverse proxy in front of `octos serve` (the octos repo's deploy docs cover the fleet setup). The app is a pure static bundle; all state lives in the server.

## Repository layout

```
src/
  runtime/     UI Protocol bridge, event router, runtime provider
  store/       thread-store, projection, voice/task/file/content/project stores
  components/  chat workbench, thread, composer, media
  home/        home-assistant surface, widget registry, voice assistant
  studio/      three-pane studio workspace
  settings/    admin dashboard tabs
  slides/  sites/  pages/  remaining surface modules
tests/         Playwright e2e specs
book/          mdBook sample reports (published to /book)
```

## License

MIT — see [LICENSE](LICENSE).
