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

The sixth binary embeds web `9911293` (runtime-identical test commit `311871a`) and core `01c3783`, SHA-256 `4895a007303f124ae1a9bd0c5287a4fd21751f105d35f6572068ae1f12867f27`, PID 7720. Strict live acceptance passes **5/5 in 22.1 seconds**, including a fresh login followed immediately by typing and sending the first draft. Actual queue/switch testing also confirms that a delayed tool turn plus queued follow-up cannot reclaim the newer active conversation (R5).

The second soak stopped after **8.6 minutes and ten completed cycles**, at cycle 11. The apparent duplicate was traced to a **test selector defect**, not duplicated stored or rendered content: substring matching concatenated cycle 1's `_1` with the adjacent timestamp `17:05`, falsely matching `_11`. DOM inspection and actual hydrated transcript each confirm one real cycle-11 reply. The selector now matches the reply's exact text independently from timestamps, and markers end in `_END`. The test also waits for the current-turn Cancel control to disappear before a completed-turn reload: previously it could disconnect just before completion, producing the server's expected connection-closed terminal. The failed run is retained and does not count as a completed soak.

Large-hydrate remediation ([core #2301](https://github.com/octos-org/octos/issues/2301)) bounds redundant canonical replay before framing and supplies per-thread continuation checkpoints. The web reconstructs compacted history from durable text, preserves terminal state, and admits subsequent live sequences without requiring the discarded delta prefix. A regression recreates 5,000 streaming events and verifies short transcript text survives actual frame serialization. Another reproduces sequence 5,001 continuation after compact hydration. Canonical activity now suppresses the false 30-second unconfirmed-send warning while retaining the optimistic user row until its durable row arrives ([web #358](https://github.com/octos-org/octos-web/issues/358)).

Actual model-generated file mutation testing confirms UI rename, downloaded bytes, rename persistence after reload, and successful UI delete. A deleted file GET returns 403 under the file resolver's authorization behavior; the original test incorrectly required 404. Final reload validation remains to be repeated. Generation also exposed [web #359](https://github.com/octos-org/octos-web/issues/359): the Files panel never refreshed on foreground completion and required a reload. A scoped canonical-terminal subscription now refreshes the listing, coalesces replay bursts, and stops on unmount.

Predeployment checks for these changes: **1,234 web tests pass across 168 files**, production build passes, lint has zero errors and 100 existing warnings. **48 backend `review_` tests pass**, canonical hydrate and core serde checks pass, and CLI library Clippy passes. A fresh deployment and uninterrupted 30-minute soak are still required. Full deck generation/render/export, remote speech capture/ASR/TTS, and learning workflow acceptance remain outstanding because this isolated lane lacks the required configured capabilities.

The seventh binary embeds runtime web `1f462eb` and core `f94d219`, SHA-256 `a1c70548c8cb2c7905debbfbbd8e613a20d2c60a405438664329cffb46aca606`, PID 8996. Actual served HTML matches the built bundle (SHA-256 `98d4be40fa4ebd4b1a59473caa6a233b2f052da59ba6d3f0cd047e31ee4be81a`). Playwright 1.60.0 and Chromium 148.0.7778.96 now run **on mini3 itself** (`macmini-3-249.local`), against its loopback server. Earlier browser tests ran locally through the SSH tunnel.

The first core suite on the remote browser was 4/5: its new completion check still relied on the disappearing streaming Cancel control, which can settle before the actual server terminal. Waiting for the canonical `turn_terminal` event fixes the completed-turn test boundary. A fresh complete suite is **5/5 in 19.8 seconds**. The failed run is preserved. Test-only commits `721ab23` and `e1dc38d` add the remote runner mode and authoritative completion wait.

Additional actual tests on PID 8996 pass: generated files appear without reload and survive UI rename/download/delete/reload (R8 and #359); an actual 36-second bash turn has no false warning after 32 seconds and its completed reply survives reload (#358); the original ~59 KB site transcript restores 49 messages with complete user/final assistant text, no oversized-field placeholders, one compact retained event, and continuation checkpoint 5061 (core #2301).

Soak attempt 3 started **2026-09-11 00:30:51 UTC**, with runner PID 9388 and server PID 8996, both on mini3. Its final result is pending. Do not infer a completed soak from startup or intermediate cycle counts.

The repeated real site-generation test builds valid React/Vite files but still cannot recover the preview after its initial signing retry budget is exhausted. The existing #356 fix handled legacy file events; this foreground build emitted canonical completion instead. The preview now subscribes to canonical tool/turn completion for its exact site topic. Its regression exhausts the initial 20-second retry window, rejects another topic's completion, then proves the correct terminal retries signing and cleanup stops later refreshes.

That same long generation exposed a separate, real duplicate-summary defect ([web #360](https://github.com/octos-org/octos-web/issues/360)). The live view contained two full final summaries; durable history contained one 2,618-character summary and a fresh reload showed one. Compact hydrate creates a temporary segment keyed by durable message ID; a buffered canonical persisted event can then carry the same message under its original iteration segment ID. The projector now reconciles that exact durable identity and retains file/tool ownership. The new regression fails on the pre-fix implementation (two bubbles) and passes with one. Equal text alone is never a merge key.

An actual revoked account-B token receives HTTP 401 from `/api/auth/me`. Reloading `/app/sites?review=expired#return-destination` redirects to `/app/login` with the complete router-relative destination retained, establishing exercised R11 behavior.
