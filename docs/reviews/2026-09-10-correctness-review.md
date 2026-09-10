Octos Web — feature completeness and function correctness review
Reviewed on September 10, 2026.

**Verdict: substantial feature coverage, but incomplete end-to-end behavior and several release-blocking correctness defects.** The passing test suite is useful evidence of covered behavior; it does not establish that account isolation, deployed voice capture, editing, or export work correctly. I found 14 actionable issues: 7 P1 and 7 P2. This is the baseline assessment before remediation; see the [remediation tracker](2026-09-10-remediation.md) for fix status.

The review is pinned to [octos-web cd5824b](https://github.com/octos-org/octos-web/commit/cd5824ba093114a8d5646da248109082c41952bb). I also inspected the corresponding API and static-file implementation in [octos baa58fb](https://github.com/octos-org/octos/commit/baa58fbc769cb6b3c498ec64e6e9bf59a1773241) to check assumptions about authentication, signed previews, and the production mount point. These are the revisions fetched during this review, not a claim about every released server/client combination.

P1 means fix before relying on the affected feature or releasing to multiple users. P2 means a reproducible functional defect that should be scheduled, but is narrower in scope. Severity is based on the exposed behavior, not on whether a test currently fails.

The assessment uses the README surfaces and the controls actually offered in the UI as the feature baseline. There is no comprehensive acceptance specification in the supplied request, so a numerical “percent complete” would imply more certainty than the evidence supports.

| Surface | What is implemented | Completeness/correctness assessment |
|---|---|---|
| Authentication and accounts | Email code, admin token, solo onboarding, auth guard, profile selection | Implemented, with account-isolation, cross-tab, transient-failure, and subpath defects: R2, R3, R10, R11. |
| Chat and runtime | Streaming projection, recovery, queued sends, uploads, tools, approvals, questions, compaction, session operations | Substantial implementation and extensive tests. Queued sends can take back a session connection after navigation: R5. |
| Home and voice/video | Voice admission, VAD, streamed audio, camera, wake word, widgets, profile-backed home configuration | Production subpath breaks VAD assets: R4. Home migration can copy another account’s data: R2. Calendar time/date handling is incomplete: R13–R14. |
| Learning | Session history, whiteboard/ink, lesson playback, source selection, camera and narration integration | Extensive implementation and unit coverage. Local learning history is not account-scoped: R2. Real lesson/ASR/TTS integration was not exercised; the learning BOM explicitly says development. |
| Slides | Gallery, scaffold/chat generation, preview, presentation, edit/reorder/delete controls, PPTX link | End-to-end editing/export is incomplete: edits do not update the generated deck, polling reverses structural edits, and the direct PPTX link omits authentication: R6–R7. |
| Sites | Presets, scaffold/chat, project files, signed preview and renewal | Working implementation paths exist, but preview execution is not isolated from app credentials and copying the preview address produces an unusable link: R1, R12. |
| Studio | Scoped chat, source catalog/import jobs, action capabilities, generated assets and structured viewers | Substantial implementation with explicit unavailable-capability states and tests. Actual skill/provider execution remains unverified. |
| Files and project launcher | File browsing/filtering, rename/delete controls, project cards, favorites/archive | File mutations are only in memory; launcher/galleries cannot rediscover server projects without local indexes: R8–R9. |
| Administration | Providers, credentials, users, authentication, channels, sandbox/tools, skills, metrics/logs, runtime control, memory and schedule panels | Broad implemented coverage. Passing settings tests and mocked navigation do not validate real providers, channel credentials, or service actions. |

The launcher’s “Shared with Me” panel is explicitly a placeholder with no sharing workflow ([src/pages/home-page.tsx:496](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/pages/home-page.tsx#L496)). The Schedule panel supports viewing and toggling jobs; it directs users to chat for creation. These are product-scope limitations, not additional hidden bugs. Cloud node-name/setup-command onboarding described in the README is not implemented in this React route tree; the paired server owns a separate landing page. The documentation should clearly distinguish those surfaces.

**R1 — P1: generated site previews can read application credentials.**

Location: [src/sites/components/site-preview.tsx:413](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/sites/components/site-preview.tsx#L413).

The iframe uses `sandbox="allow-scripts allow-forms allow-same-origin"` while loading `/api/preview-signed/...` from the application origin. This permits generated JavaScript to access the parent document and its localStorage. A signed URL authorizes access to content; it does not isolate that content from the hosting application.

I rendered the real SitePreview component in Chromium and served a harmless generated page that read a synthetic localStorage token into a parent DOM attribute. It successfully read `review-only-sentinel`. No real credential or third-party destination was used. The inspected server adds Referrer-Policy, but no sandbox CSP that compensates for this: [crates/octos-cli/src/api/handlers.rs:4072](https://github.com/octos-org/octos/blob/baa58fbc769cb6b3c498ec64e6e9bf59a1773241/crates/octos-cli/src/api/handlers.rs#L4072).

Impact: visiting a generated site can expose the session/admin token or permit authenticated actions under the viewer’s account. Opening that same-origin preview in a new tab also needs isolation; fixing only the iframe attribute does not solve the top-level case.

Fix: serve executable previews from an origin without app credentials, and apply an appropriate sandbox policy. If an opaque iframe origin is used, configure module/asset CORS deliberately instead of restoring same-origin privileges.

**R2 — P1: logout leaves private feature data available to the next account, and Home can upload it into that account.**

Locations: [src/api/client.ts:8](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/api/client.ts#L8), [src/slides/store.ts:4](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/slides/store.ts#L4), [src/sites/store.ts:8](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/sites/store.ts#L8), [src/learning/learning-session-store.ts:22](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/learning/learning-session-store.ts#L22), [src/home/home-settings-context.tsx:459](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/home/home-settings-context.tsx#L459).

Token clearing removes chat session indexes but not the origin-wide slides, sites, learning, or Home data. Slide/site/learning loaders do not filter by the authenticated identity. Site records even retain the previous profile ID.

Reproduction: account A creates a deck with private notes, a site, or a learning session; call the normal logout token-clear path and sign in as B in the same browser. B’s loaders still return A’s records. Three separate regression probes reproduce this.

The Home path has a stronger consequence. When B has no Home configuration, it merges the retained calendar/photos/feed settings and automatically calls `updateMyProfileConfig` for B. A fourth probe confirmed A’s private appointment in the payload targeting profile B.

Fix: namespace all durable feature data by verified identity/profile, clear the active identity’s in-memory state on transition, and bind migrations to an identified owner. Retaining an offline cache must not make it a migration source for another account.

**R3 — P1: switching accounts in one tab leaves another tab displaying A while requests execute as B.**

Locations: [src/auth/auth-context.tsx:46](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/auth/auth-context.tsx#L46), [src/auth/auth-context.tsx:150](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/auth/auth-context.tsx#L150), [src/runtime/ui-protocol-runtime.ts:693](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/runtime/ui-protocol-runtime.ts#L693).

AuthProvider snapshots the token into React state and does not subscribe to token storage events. The bridge teardown events are local window events; they do not propagate to other tabs. Meanwhile REST requests read the latest token from shared localStorage.

Reproduction with two real Chromium tabs: A is signed in in both tabs; replace the account in tab 2. In tab 1, AuthProvider still reports A and A’s token, but clicking “Read profile” sends `Authorization: Bearer review-account-b`. A separate React probe reaches the same result.

Impact: an old account’s UI and cached data can be paired with a new account’s REST operations. Existing WebSockets also lack a storage-driven teardown path; the browser probe did not attempt a real server privilege escalation through those sockets.

Fix: make auth identity changes observable across tabs, invalidate all identity-bound stores and pending work, close both active and auxiliary bridges, and revalidate before displaying the next principal.

**R4 — P1: voice capture fails when the application is deployed under /app/.**

Location: [src/home/voice/use-voice-capture.ts:71](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/home/voice/use-voice-capture.ts#L71). Production mount evidence: [crates/octos-cli/src/api/static_files.rs:124](https://github.com/octos-org/octos/blob/baa58fbc769cb6b3c498ec64e6e9bf59a1773241/crates/octos-cli/src/api/static_files.rs#L124).

The VAD worklet, model and WASM URLs are hard-coded to `/vad/` and `origin + "/vad/"`. The app’s production bundle is mounted under `/app/`, so these files belong under `/app/vad/`. The wake-word code already uses BASE_URL, but this capture hook does not.

A browser probe ran the actual capture hook against Vite configured with `BASE_URL=/app/`. Every requested `/vad/...` asset returned 404, and capture displayed `VAD asset unavailable: /vad/vad.worklet.bundle.min.js (404)`. The same model at `/app/vad/silero_vad_v5.onnx` returned 200.

Fix: derive both asset bases from `import.meta.env.BASE_URL`; resolve the ONNX dynamic-import base against the origin. Add a production-subpath browser check, since the root-mounted smoke suite misses this.

**R5 — P1: an old queued chat can take over the newly selected session’s bridge.**

Locations: [src/runtime/ui-protocol-send.ts:550](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/runtime/ui-protocol-send.ts#L550), [src/runtime/ui-protocol-send.ts:762](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/runtime/ui-protocol-send.ts#L762), [src/runtime/runtime-provider.tsx:125](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/runtime/runtime-provider.tsx#L125).

A queued send waits for the preceding turn’s lifecycle. Closing the old bridge releases that lifecycle gate. The queued continuation then calls `startBridgeForSession` for its original session, without checking whether the owning session view or identity has changed. This function controls the application’s single active bridge.

Reproduction: enqueue two messages in A, allow the first to start, then perform the React-style cleanup of A and start of B without awaiting cleanup. The isolated probe uses the real send queue and runtime registry with controllable bridge doubles. The old queued message is sent through a reopened A bridge, and `getActiveBridge("web-b")` returns null.

Impact: the selected conversation can lose its connection and recovery subscriptions after navigation. The old queued turn may also run after the user has left that surface.

Fix: carry an ownership/identity generation with queued sends. On scope teardown, either cancel pending sends with an explicit state or keep them on a separately owned background transport. They must not republish themselves as the active UI bridge.

**R6 — P1: manual slide editing does not edit the generated deck, and polling undoes reorder/delete.**

Locations: [src/slides/context/slides-context.tsx:119](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/slides/context/slides-context.tsx#L119), [src/slides/context/slides-context.tsx:156](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/slides/context/slides-context.tsx#L156), [src/slides/context/slides-context.tsx:185](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/slides/context/slides-context.tsx#L185).

Edit, move and remove callbacks update localStorage only. No generation/persistence operation applies those edits to the source or PPTX. On each poll the provider reconstructs the entire slide list from the backend manifest in manifest order, even when the manifest generation stamp has not changed.

Two probes reproduce the immediate symptom: delete slide 1 from a two-slide deck and it reappears after the 5-second poll; move slide 1 after slide 2 and the original order returns on that poll. Title/notes/layout metadata can survive matching by filename, but the preview still displays the old PNG and the export still points to the original PPTX.

Fix: establish an authoritative editable deck model and persist/regenerate changes. Reconcile genuinely new backend output without discarding user structural edits. Until then, the UI should not present local metadata editing as editing the generated presentation.

**R7 — P1: the PPTX download control omits authentication.**

Locations: [src/slides/api.ts:367](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/slides/api.ts#L367), [src/slides/components/slide-preview.tsx:352](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/slides/components/slide-preview.tsx#L352); the empty-preview branch also uses the same plain anchor.

Hydration creates `pptxUrl` with `buildFileUrl`, which supplies neither a token nor an authenticated blob. The preview component renders it directly in an `<a download>`. The server’s file routes expect authentication from headers/query or a configured trusted proxy; app localStorage is not sent automatically. See [crates/octos-cli/src/api/router.rs:1156](https://github.com/octos-org/octos/blob/baa58fbc769cb6b3c498ec64e6e9bf59a1773241/crates/octos-cli/src/api/router.rs#L1156).

I clicked the actual “Download PPTX” control and captured the request through a local mock upstream: no Authorization header, no cookie, no token query. The protected upstream returned 401. This applies to ordinary bearer-token deployments; a proxy that independently authenticates the download could mask it.

Fix: use the existing authenticated download pattern to fetch a blob and download it, with visible errors. Prefer an explicitly scoped short-lived download URL if browser navigation is necessary.

**R8 — P2: file Delete and Rename controls do not persist their changes.**

Locations: [src/components/content-browser.tsx:305](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/components/content-browser.tsx#L305), [src/components/content-browser.tsx:326](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/components/content-browser.tsx#L326), [src/store/file-store.ts:120](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/store/file-store.ts#L120).

The controls call `removeFile` / `renameFile`, which only mutate the in-memory array. They never call a server mutation endpoint. A deleted file returns when the session file listing is loaded again; a renamed file returns to its backend name after a fresh page load.

A regression probe loads a session file, deletes it through the same store operation the UI uses, then reloads the session. The supposedly deleted file reappears. The rename path is confirmed by code tracing.

Fix: persist file/catalog mutations before updating the display, with rollback on failure. If “remove from this view” is the intended feature, label and persist that preference explicitly rather than calling it Delete.

**R9 — P2: launcher and galleries cannot rediscover existing projects in a fresh browser.**

Locations: [src/store/project-store.ts:131](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/store/project-store.ts#L131), [src/store/project-store.ts:153](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/store/project-store.ts#L153), [src/pages/home-page.tsx:245](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/pages/home-page.tsx#L245).

The launcher aggregates only localStorage slides, sites and chat titles. Its refresh invalidates that local snapshot; it does not request the server’s session/project index. The dedicated galleries also read their local project stores. Direct editor hydration exists, but requires an already-known ID.

A browser probe supplied a valid existing account and a mock server capable of returning an existing session. The actual home route displayed “Welcome to Octos,” showed no existing project, and made zero `session/list` calls. Normal logout also clears the chat title index, so returning users can see this without changing devices.

Fix: hydrate the authenticated project/session index on launcher and gallery entry, then merge local drafts and decorations. Local caches should accelerate discovery, not be its sole source.

**R10 — P2: a temporary /me failure destroys a valid login.**

Location: [src/auth/auth-context.tsx:123](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/auth/auth-context.tsx#L123) and the revalidation catch at [src/auth/auth-context.tsx:136](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/auth/auth-context.tsx#L136).

Both paths treat any exception as invalid authentication and call token clearing. A network interruption or server 5xx therefore removes valid credentials and redirects to login. A probe with an existing token and `TypeError("Failed to fetch")` from the auth request confirmed that localStorage’s token becomes null.

Fix: clear credentials on explicit authentication rejection; retain them and show a retry/offline state on transport or server failure. Apply the same distinction to startup and later revalidation.

**R11 — P2: auth-expiry redirects escape the application’s base path.**

Location: [src/api/client.ts:235](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/api/client.ts#L235).

The REST auth reaper assigns `window.location.href = "/login?..."` regardless of BASE_URL. From a production `/app/` deployment it should lead to `/app/login`. It also puts the already-prefixed pathname into a redirect parameter that the app’s router interprets relative to its basename.

The subpath browser probe captured navigation to `http://127.0.0.1:5175/login?redirect=%2Fapp%2F...`, outside the configured app. In the embedded server a fallback may redirect back to the app root, but that loses the intended destination rather than implementing the promised return flow.

Fix: centralize the redirect in the router-aware auth provider, or consistently add the base to the login URL and remove it from the stored in-app destination.

**R12 — P2: Copy preview URL copies the unsigned, relative URL.**

Location: [src/sites/components/site-preview.tsx:293](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/sites/components/site-preview.tsx#L293).

The iframe and “open in new tab” action use the signed preview URL, but Copy writes the legacy `previewUrl`. The browser probe copied `/api/preview/review-profile/site-review/demo/index.html`, while the working iframe was at `/api/preview-signed/review-signed-token/index.html?v=0`.

The copied path is not a portable absolute URL and does not carry the authorization needed for a direct navigation. This makes the copy action fail even while the preview itself works.

Fix: provide an absolute, appropriately scoped preview link and make expiry/access expectations visible. Coordinate this with the preview-origin isolation fix in R1.

**R13 — P2: imported calendar timestamps ignore timezone information.**

Location: [src/home/use-events.ts:63](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/home/use-events.ts#L63).

The parser copies date/hour/minute digits and ignores the UTC `Z` suffix and DTSTART timezone parameters. For a browser in Los Angeles, `20260911T020000Z` should display September 10 at 19:00, but the parser returns September 11 at 02:00. The regression probe confirms both the wrong hour and wrong day.

The import parser also ignores recurrence rules, so recurring feed entries are not expanded; this is an additional limitation of the same minimal feed implementation, confirmed statically.

Fix: use a calendar parser with timezone/recurrence semantics, preserving all-day and floating events correctly, and expand occurrences only within the widget’s display window.

**R14 — P2: the always-on Home calendar stays on yesterday after midnight.**

Location: [src/home/use-events.ts:163](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/home/use-events.ts#L163).

Today/upcoming lists are memoized using only `events` and `feedEvents`. Clock ticks and component rerenders do not invalidate them. The feed is also only fetched when its URL changes. An unchanged standby screen therefore retains the previous date’s classification.

A fake-clock probe starts at 23:59:59, advances across midnight, and rerenders the hook. Tomorrow’s appointment still does not appear in Today.

Fix: include a reactive local-date key, refresh on midnight/resume, and refresh external calendar feeds at a suitable cadence.

The following checks were executed against the isolated checkout:

| Check | Baseline result |
|---|---|
| Frozen pnpm install | Passed |
| Existing unit suite | 160 files, 1,189 tests passed |
| ESLint | 0 errors, 97 warnings |
| TypeScript + Vite production build | Passed |
| Existing Chromium UI smoke suite | 24 passed, retries disabled |
| New targeted regression probes | 12 intended-behavior assertions fail, reproducing the documented defects; no unhandled test errors in the final run |
| Actual browser component probes | Preview token access, unsigned copy, unauthenticated download, cross-tab mismatch, subpath voice failure and wrong auth redirect reproduced |
| Actual launcher with a fresh browser store | Existing server project not requested or shown |

The first concurrent lint attempt collided with Vite’s temporary generated config file. I reran lint after those checks completed; the table records that completed run, not the tooling race. The initial dependency installation used the available Node 24 runtime; all recorded validation used Node 22.23.2 and pnpm 11.5.2, matching the CI major version.

The baseline browser evidence is preserved in [component results](evidence/2026-09-10-browser-baseline.json) and [launcher results](evidence/2026-09-10-launcher-baseline.json). All credentials in that evidence are synthetic sentinels.

The original 12 failing probes have been adapted into permanent regression tests in `src/regressions/`. They now exercise the server persistence contract and pass with the remediation. Browser scenarios live in `tests/review-correctness.spec.ts`; their fixture uses synthetic accounts and does not require provider credentials. Run the maintained checks with:

```sh
pnpm exec vitest run src/regressions
pnpm exec playwright test --config playwright.review.config.ts
```

The review did not run a configured live Octos server, real model/ASR/TTS services, cloud signup/email delivery, physical microphone/camera sessions, smart-home equipment, or third-party channel operations. The existing browser smoke suite uses mocked REST/WebSocket responses. Backend assumptions for the findings were checked against source, while browser and state-machine behavior were executed locally. This is a deep targeted review, not proof that every path in this large codebase has been exhausted.

Recommended sequence: first isolate executable previews and all account state (R1–R3), then restore production voice and session lifecycle correctness (R4–R5), then finish authoritative editing/download flows (R6–R9), and resolve auth/calendar/link correctness (R10–R14). Extend CI with account-switch, subpath, poll-after-edit and authenticated-download scenarios. The README should also stop claiming compatibility with the old notification render path: the current bridge explicitly rejects a server without `projection.envelope.v2` ([src/runtime/ui-protocol-bridge.ts:3038](https://github.com/octos-org/octos-web/blob/cd5824ba093114a8d5646da248109082c41952bb/src/runtime/ui-protocol-bridge.ts#L3038)).

