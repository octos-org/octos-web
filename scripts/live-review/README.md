These checks use an isolated Octos server, real authentication, real model/tool calls, and the production `/app/` bundle. They create synthetic conversations and projects; the file check renames and deletes its own generated file. They incur provider usage. Use dedicated `@example.invalid` test accounts with the required capabilities configured.

Install the repository dependencies and Playwright Chromium, then configure:

```sh
export OCTOS_LIVE_REVIEW_URL=http://127.0.0.1:55080/app/
export OCTOS_LIVE_REVIEW_CREDENTIALS=/absolute/path/to/restricted-credentials.json
pnpm exec playwright test --config=playwright.live-review.config.ts
```

The restricted JSON file contains `a`, `b`, and `owner`, each with `email`, `id`, and a real session `token`. The token-revocation check additionally needs the isolated server's configured `otp`. Keep this file outside tracked paths with mode 0600. Account logout revokes that token: obtain a new session through the actual verify endpoint before reusing it.

For a 30-minute soak, run the same test config with `OCTOS_LIVE_REVIEW_SOAK=1`, `OCTOS_LIVE_REVIEW_PID=<owned-server-pid>`, and `OCTOS_LIVE_REVIEW_SSH=<ssh-alias>`. Set the SSH value to `local` when both Chromium and the runner execute on the remote mini itself. The soak records the runner hostname, browser version, server process measurements, reply latency, socket counts, errors, and screenshots. It waits for actual canonical turn completion before reloading. It uses no retries or fulfilled API routes. A stopped or failed run does not count as a completed soak.

Standalone feature checks:

| Command | Exercised behavior |
|---|---|
| `node scripts/live-review/files.mjs` | Actual generated file appears without reload; UI rename, download bytes, delete, and persistence |
| `node scripts/live-review/long-turn.mjs` | Actual 36-second tool turn stays accepted without a false 30-second timeout |
| `node scripts/live-review/long-chat.mjs` | Long real streamed reply remains one intact message across compaction and reload |
| `node scripts/live-review/tool-activity.mjs` | Real web searches/fetches collapse into one expandable activity; a Chinese follow-up retains supplied venue context without another report table |
| `node scripts/live-review/expired-auth.mjs` | Actual revocation and 401 retain `/app/` and the full login return destination |
| `OCTOS_LIVE_REVIEW_SLIDES_SESSION=slides-… node scripts/live-review/slides-links.mjs` | Fresh direct editor and presentation links hydrate an existing real scaffold |
| `node scripts/live-review/site.mjs` | Real React/Vite generation, initial preview recovery, module interaction, storage isolation, and copied signed URL |

Artifacts go to ignored `test-results/live-review-*` directories. `OCTOS_LIVE_REVIEW_OUTPUT` changes the standalone feature output root. Inspect screenshots before sharing; never publish credentials, browser storage state, signed preview URLs, or authenticated WebSocket URLs. Traces are disabled in the Playwright config for this reason.

For the tool-activity check, set `OCTOS_LIVE_REVIEW_WEB_COMMIT` and `OCTOS_LIVE_REVIEW_CORE_COMMIT` to the deployed revisions to record them in its result. It checks both supplied venue facts and the originally reported Saratoga-weather → Beijing follow-up. The weather case requires an actual lookup and checks reply format/context; it does not independently certify the returned measurements. The runner saves observed follow-ups and screenshots before assertions, so a model formatting failure remains inspectable.

The site check asks the model to avoid cleanup commands. If the model requests an approval, the harness must stop for inspection rather than silently grant arbitrary commands. A valid build behind an approval dialog is not a passing interaction test. Generated model output can also violate fixture instructions; report that separately from application failures.

These checks do not certify image generation, complete deck rendering/export, ASR/TTS, learning lessons, external channels, physical hardware, or the designated public canary. See the tracked live-validation record for the tested capabilities and exact build hashes.
