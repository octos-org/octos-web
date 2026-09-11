# Remote mini live validation — 2026-09-10

Status: in progress. This document supplements the [14-finding remediation tracker](2026-09-10-remediation.md); implementation and mocked CI do not establish live acceptance.

Target discovery: SSH alias `mini3` resolves to an ARM64 Mac at `69.194.3.249`. Read-only inspection found no Octos process or TCP listener. Use a dedicated, disposable instance under `/Users/cloud/.octos/outer/`, with separate profile/session directories and only synthetic test users. The browser will reach the real remote API and production `/app/` bundle through an SSH tunnel. This proves the remote mini lane; it is not a public-canary deployment certification.

The server branch was synchronized with `origin/main` before building. Record exact server/web commits, binary and bundle hashes, process IDs, start/end times, model route, and effective capabilities in the evidence manifest. Credentials stay in ignored, permission-restricted files and must be removed from screenshots/traces/logs before publishing evidence.

Acceptance scope:

| Findings | Required live evidence |
|---|---|
| R1, R12 | Generate/serve a site through the actual server; module execution works; iframe and direct preview cannot access app credentials; copied signed URL opens in a separate context |
| R2, R3 | Two real test accounts; private Home/slides/sites/learning state does not cross accounts; switching one tab updates another; late work cannot reappear under the new account |
| R4 | Production `/app/` VAD worklet, ONNX models and WASM load; start capture and produce a speech segment using browser audio input; record ASR/TTS capability and live results separately |
| R5 | Queue a second message in A while a real turn is running; switch to B; A's completion must not reclaim B's active conversation |
| R6, R7 | Create a real deck, edit/reorder/delete through the UI, regenerate via the real model workflow, reload, and inspect downloaded PPTX bytes and rendered slides against the saved revision |
| R8 | Rename and delete test files through the UI; verify disk/list/download state after reload and in a fresh browser |
| R9 | A fresh browser discovers existing chat/site/slide projects from the actual authenticated server |
| R10, R11 | Controlled network failure preserves a valid login; explicit auth rejection routes to `/app/login` with a usable return destination |
| R13, R14 | Serve calendar fixtures as real files; verify displayed local date/time and midnight/resume refresh in browser contexts |

After feature acceptance, run at least 30 continuous minutes of browser operations with real chat requests, navigation, reloads, session switches, reconnects, and artifact retrieval. Record every cycle, latency, browser/server errors, socket and process health, and memory samples. Do not replace failed live flows with mocked responses or count retries as an uninterrupted successful soak. Retain failed-run evidence and fix reproducible defects before rerunning acceptance.

Completion requires inspected live results for each row and a successful sustained soak. Missing capabilities, failed flows, partial runs, or stale binaries remain explicit outstanding work.

## Live discoveries (acceptance still incomplete)

The first deployed build embedded web `1fae296` and core `caf603c8`; binary SHA-256 `8d3387d8036cd3a2006cf6b193ef7c7d82cee03e728e9f7da342aa4ab65b7a7d`. The isolated server started at port 55080 as PID 4711. Three synthetic accounts were provisioned through the real auth/profile API. DeepSeek's live model catalog and an actual browser text response confirmed the `deepseek-flash` route.

The first run failed because the test setup launched standalone profile gateways that locked the same databases needed by `serve`. Gateways were disabled/stopped through the admin API. This setup failure is retained; it is not a successful acceptance run.

Subsequent browser inspection found additional defects:

| Issue | Evidence | Remediation under validation |
|---|---|---|
| [#351](https://github.com/octos-org/octos-web/issues/351) | Core's `data_dir_locked` diagnosis became a misleading browser network/origin error | Preserve the typed startup diagnosis and stop futile automatic reconnects |
| [#352](https://github.com/octos-org/octos-web/issues/352) | Slide scaffold persisted to its topic, while browser open/hydrate frames addressed the root session | Send topic on open and scoped session ID on hydrate |
| [#353](https://github.com/octos-org/octos-web/issues/353), [core #2298](https://github.com/octos-org/octos/issues/2298) | A real reply left duplicate optimistic text and a 1969 user date; hydration re-numbered the active thread before its terminal arrived | Return retained canonical events, preserve their sequence through hydration, retain available user timestamps, and hide confirmed optimistic rows |

The second isolated binary, SHA-256 `75b618e2cf201aa454c5c7ce7f19cb29c57426d2bc9ea420b298e4c82cb07ffd`, replaced PID 4711 with PID 5504. It contains the above fixes. Focused web regressions pass, the full web unit suite passes 1,225 tests across 167 files, the production build passes, and eight server hydrate regressions pass. Live acceptance is being rerun. No soak completion is claimed.

New live tests are in `tests/live-review/`, using `playwright.live-review.config.ts`. They require an explicit real server URL and a restricted credentials file, use one worker and zero retries, and never fulfill API responses. A network-failure test aborts the real validation request deliberately. Traces are disabled because WebSocket URLs contain credentials. Reports record URL paths, timestamps, errors, socket counts, model response latency, and remote process health.

Run core acceptance with `OCTOS_LIVE_REVIEW_URL`, `OCTOS_LIVE_REVIEW_CREDENTIALS`, and `pnpm exec playwright test --config playwright.live-review.config.ts`. Set `OCTOS_LIVE_REVIEW_SOAK=1`, `OCTOS_LIVE_REVIEW_SSH`, and `OCTOS_LIVE_REVIEW_PID` for the separate 30-minute core UX soak. Its scope is real text chat, history, navigation, and reconnect; it does not certify the outstanding media/artifact matrix above.

The first strict live suite on the second binary finished with **2 passed, 2 failed**: queued real replies and transient-auth recovery passed; first chat after restart and slide discovery failed. The first-chat error confirmed the new diagnosis UI worked, but exposed [core #2299](https://github.com/octos-org/octos/issues/2299): concurrent cold requests could initialize the same profile twice and conflict on redb within one process. The slide failure exposed [core #2300](https://github.com/octos-org/octos/issues/2300): file listing required a standalone gateway API port despite the valid in-process serve runtime. Both fixes are under regression and live validation. The failed run is retained; it does not count as soak evidence.

The third binary embedded web `701b172` and core `b2d3c08`, SHA-256 `b681c711928471fd59d29512081267ded174f3a2565a44bab7118975748c94bb`, PID 5842. Strict live acceptance finished **3 passed, 1 failed**: cold-start chat, reload/reconnect, queued replies, and transient-auth recovery passed. Slide topic history loaded and the actual file API returned HTTP 200 with the scaffold files. The file panel still hid them because it checked the unrelated standalone-gateway status ([web #354](https://github.com/octos-org/octos-web/issues/354)). Both slide and site panels now query the file API directly and surface its actual errors; regression tests also verify polling stops after unmount. This fix requires another deployed live run. The failed run is retained.

Capability discovery found working live DeepSeek text inference, installed `mofa-slides` and `mofa-site` skills for the synthetic review account, and Node.js on mini3. OMiniX voice reports unavailable, no configured image/speech provider has been supplied, and LibreOffice/Quarto are absent. These are outstanding acceptance prerequisites, not successful media tests.

The fourth binary embedded web `3ae0b08` and core `b2d3c08`, SHA-256 `1c61535ada97ba2f10c96b201afcb779b8afea702907d35365c397597c4b6b0f`, PID 6238. An immediate test launch preceded HTTP readiness and failed all four navigations; after verifying HTTP 200, a fresh strict run passed three tests and reached the fresh-browser step of the fourth. Scaffold files and history now load correctly. Fresh discovery exposed [#355](https://github.com/octos-org/octos-web/issues/355): verified cache restoration cancels an auxiliary connection without changing the token, and the remounted hook reuses its doomed pending promise. Discovery now invalidates both pending work and publication generation on that reset.

An actual DeepSeek tool turn generated a React/Vite counter and executed `npm build` on mini3. The initial pre-scaffold signing 404 remained stuck even after the real signing endpoint returned 200 ([#356](https://github.com/octos-org/octos-web/issues/356)). Preview refresh now retries a failed sign and uses bounded retries for a not-yet-created scaffold. Nineteen focused discovery/preview tests pass; lint has zero errors and 100 existing warnings; the production build passes.

Reopening the generated site succeeded: Chromium executed its ES module and incremented the counter; both iframe and direct preview storage access threw; the copied signed URL opened and worked in an unauthenticated browser context. This establishes the exercised R1/R12 preview behavior, while initial scaffold-to-preview recovery still needs the next binary. The large tool turn also exposed truncated hydration content (`[oversized field omitted]`) and a transient send-confirmation timeout; these are under investigation and prevent an unqualified correctness claim.

Backend CI found a missing new-field initializer in an existing `octos-core` serde test. Commit `01c3783` fixes that test-only omission; the targeted serde test passes. This does not change the running server behavior.

The fifth binary embeds web `0d919d8` and core `01c3783`, SHA-256 `09845172378cd6fcc0aa981b23bdacfc562034ff61fa855623794ffedd913d66`, PID 7161. Strict remote core acceptance passes **4/4 tests in 17.7 seconds**. A separate real two-account browser test passes cross-tab logout, slide/site index isolation, Home calendar configuration isolation, and clearing/restoring a synthetic learning draft for its verified owner. Actual logout revokes a token; the first account-test attempt incorrectly reused one, and the corrected setup obtains each login token through the actual verify endpoint.

Actual calendar files are served from a separate loopback HTTP fixture server on mini3. Chromium in America/Los_Angeles displays New York 09:30 as 06:30 and UTC 18:00 as 11:00. Advancing the browser clock through local midnight replaces today's events, refetches the feed, and a visibility-resume event refetches again. All observed calendar fixture responses are HTTP 200. This establishes exercised R13/R14 behavior.

The first soak attempt began at 23:54 UTC but completed **zero cycles** and was stopped. A fresh account's first typed draft disappeared during a late auth/cache remount ([#357](https://github.com/octos-org/octos-web/issues/357)); the harness then waited on the disabled send button. Action/navigation timeouts are now bounded to 30 seconds and per-operation startup telemetry is recorded. The failed screenshot is retained. No successful soak is claimed. The auth fix ties loading completion to the latest validation request, rather than only its token generation.

[Core #2301](https://github.com/octos-org/octos/issues/2301) tracks the large tool-turn hydration loss. On-disk site transcript content remains intact (~59 KB); loss occurs while composing/framing the hydrate response, so it must not be treated as a successful restored conversation.
