# Correctness review remediation — 2026-09-10

This tracks the 14 confirmed gaps in [the baseline review](2026-09-10-correctness-review.md). All have implementation and regression coverage in [web PR #350](https://github.com/octos-org/octos-web/pull/350), based on web `cd5824b`. Issues remain open pending review and merge. No deployment or live-service validation is claimed.

The required server changes are in [octos#2296](https://github.com/octos-org/octos/pull/2296), based on server `88d1112`: preview sandbox headers/CORS, durable file mutations, and revisioned slide-edit storage. Release that API before the paired web client. An older server can still preview decks, but edit/mutation attempts will show an error.

| Finding / issue | Implemented behavior | Regression coverage |
|---|---|---|
| R1 [#336](https://github.com/octos-org/octos-web/issues/336) | Opaque iframe origin; server CSP also isolates direct navigation; signed assets allow module CORS | Chromium executes a module but cannot read parent/top-level storage; server full-router signed preview test |
| R2 [#337](https://github.com/octos-org/octos-web/issues/337) | Verified-owner cache archive/restore; private active caches and memory reset; Home migration checks its owner | `identity-cache.test.ts`, `regressions/review-correctness.test.tsx`, `regressions/home-identity.test.tsx` |
| R3 [#338](https://github.com/octos-org/octos-web/issues/338) | Storage events trigger revalidation and remount; late requests cannot apply a prior account's response | Real two-tab Chromium test; late auth rejection and binary-response tests |
| R4 [#339](https://github.com/octos-org/octos-web/issues/339) | VAD worklet, model, and ONNX assets honor `BASE_URL` | Actual VAD initialization in Chromium with fake microphone and real assets under `/app/` |
| R5 [#340](https://github.com/octos-org/octos-web/issues/340) | Queued sends retain account/session generation and cancel when their conversation is retired | `regressions/queued-scope.test.tsx` checks B remains active after old A terminates |
| R6 [#341](https://github.com/octos-org/octos-web/issues/341) | Server saves a revisioned edit document; existing slides workflow regenerates outputs; polling preserves pending edits; export waits for matching revision and fresh outputs | Backend persistence/conflict/ownership tests; `slides/edit-artifacts.test.ts`; edit, reorder, delete, reload, failed-save, and render-application regressions |
| R7 [#342](https://github.com/octos-org/octos-web/issues/342) | PPTX downloads fetch with authentication and show failures/retry | Chromium checks auth header and downloaded bytes, plus HTTP 401 behavior |
| R8 [#343](https://github.com/octos-org/octos-web/issues/343) | Rename/delete persist on the server; UI changes only after confirmation; stale listings/history cannot revive removed paths | Actual filesystem mutation and cross-profile rejection tests; file reload regression; content-browser tests |
| R9 [#344](https://github.com/octos-org/octos-web/issues/344) | Launcher/galleries discover authenticated sessions and hydrate missing slide/site projects while preserving local drafts | Fresh-browser actual launcher test; `project-discovery.test.ts` covers all types, drafts, late account responses |
| R10 [#345](https://github.com/octos-org/octos-web/issues/345) | Temporary `/me` failure keeps credentials and offers retry; only explicit rejection logs out | Auth recovery regression and existing auth tests |
| R11 [#346](https://github.com/octos-org/octos-web/issues/346) | Auth expiry uses the app base and preserves a router-relative return destination | Chromium `/app/` redirect test |
| R12 [#347](https://github.com/octos-org/octos-web/issues/347) | Copy uses the same absolute signed capability URL as preview/open | Chromium clipboard result; component tests |
| R13 [#348](https://github.com/octos-org/octos-web/issues/348) | ICAL.js parses calendar data; IANA/embedded zones, floating dates, recurrence exceptions, and DST are interpreted before local display | `home/calendar-timezones.test.ts` and UTC conversion regression |
| R14 [#349](https://github.com/octos-org/octos-web/issues/349) | Local midnight/resume updates date groups; feeds refresh on a timer and resume | Fake-clock midnight regression |

Local-only work is archived under a profile ID verified by `/me`, and restored only for that owner. Unknown legacy caches are quarantined instead of being assigned to whoever logs in next. Home's older migration requires its recorded owner to match. This is application-level account separation on a shared browser, not encryption against someone with access to the browser profile. Existing unowned local-only work needs an explicit owner-confirmed recovery flow; it is retained in storage and never silently uploaded to another account.

Manual edits are durable workflow inputs, not immediate direct manipulation of PPTX bytes. Saving queues regeneration through the existing slides chat workflow. The client requires the exact saved revision in `manual-edits-applied.json`, the expected slide count, and nonempty PNG/PPTX files modified after the save before showing the output as current. Failed saves retain the editor draft; failed or incomplete rendering leaves pending status and a retry. Live provider/render quality has not been verified. Concurrent saves return HTTP 409 rather than silently overwriting a newer revision.

Validation: Node 22.23.2 / pnpm 11.5.2 on macOS; the full web unit suite passes 1,220 tests across 167 files; ESLint reports 0 errors and 100 warnings; TypeScript and the `/app/` production build pass. The combined Chromium suite passes 31 tests (24 existing smoke checks plus 7 correctness checks), with retries disabled. The server passes 50 targeted tests and `cargo clippy -p octos-cli --lib --no-deps`. Backend Unix filesystem operations use anchored no-follow descriptors; Windows rejects symlinks/reparse points via the existing platform fallback approach and still requires platform CI. No full server workspace test run or live model/ASR/TTS, email, physical hardware, sharing, or third-party integration verification is claimed.

CI runs the combined browser suite through `playwright.review.config.ts`, which owns both root and `/app/` Vite servers and retains traces/screenshots on failure. Reproduce locally:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test:unit
BASE_URL=/app/ pnpm run build
pnpm exec playwright install chromium
pnpm test:review

# In the paired octos checkout:
cargo test -p octos-cli --lib review_
cargo test -p octos-cli --lib api::file_mutations::tests
cargo test -p octos-cli --lib api::slide_edits::tests
cargo clippy -p octos-cli --lib --no-deps
```

The baseline also identifies product limitations rather than verified defects: “Shared with Me” has no sharing workflow, job creation is through chat, cloud onboarding is a separate server landing page, and live learning/provider/channel integrations remain unverified. Those are not represented as completed features by this remediation. README transport guidance now accurately states the required `projection.envelope.v2` capability.
