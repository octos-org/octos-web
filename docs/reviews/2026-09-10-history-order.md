# Old question displayed after the latest reply

[Web #367](https://github.com/octos-org/octos-web/issues/367) tracks the confirmed cause of the reported repeated Beijing exchange. This is a history-order defect; the earlier concise-follow-up prompt change did not fix it.

## Evidence

The user's existing Safari conversation ended with a San Francisco question and answer followed by an older Beijing question and answer. The durable server transcript contains six user turns, with Beijing third and San Francisco last. Beijing was stored at 03:53 UTC; San Francisco was stored at 06:34 UTC. There is no newly stored Beijing question after San Francisco.

A read-only Playwright run on mini3 reproduced the same inversion on web `b28f36a`: the third turn appeared last. Its [before-fix observation](evidence/2026-09-10-history-order/chromium-before.json) records actual rendered thread identifiers against the server transcript order. It submits no messages. Full conversation text, credentials and raw protocol captures are excluded from published evidence.

## Cause and fix

The hydrate response retained all 349 canonical events for the shorter Beijing turn. Longer later turns exceeded the replay compaction threshold and used durable transcript fallbacks. `hydrateProjectionEnvelopes()` appended all fully retained turns after those fallbacks; the projector renders turns in first-seen order. Thus the older Beijing exchange moved to the end whenever this mixed history was restored.

Web `ea8ce95` preserves the transcript's turn order when replacing synthetic envelopes with retained canonical events. Stable ordering preserves exact per-thread sequence coordinates and keeps live/background-only turns available. No stored conversation content is deleted, rewritten or hidden.

The regression fails on the preceding implementation with the same order inversion. After the fix, three consecutive snapshot replacements preserve the user/assistant pairs in order, retain canonical coordinates and leave no sequence gap. All **53 focused tests** and **1,259 unit tests** pass; lint reports **zero errors and 105 warnings**. Type checking and the production `/app/` build pass.

The reusable [`history-order.mjs`](../../scripts/live-review/history-order.mjs) opens an existing conversation, compares visible user-turn identifiers with the actual server transcript, and repeats the check after two reloads. It does not send model prompts or fulfill API responses.

## Deployment and final verification

The first deployment attempt used a debug binary without the `rust-embed/debug-embed` feature. Its `/app/` route returned `503 web_bundle_missing`, and the two browser checks could not reach login. The preceding working binary was restored immediately. Those failures are packaging failures and do not count as passed history checks. The replacement was rebuilt with embedded assets, launched independently on a separate loopback port/data directory, and required HTTP 200 plus exact expected HTML bytes before replacing the working service.

The isolated mini3 instance now runs web **`ea8ce95`** / core **`7590b73`**, PID **23885**. Binary SHA-256: `e39d46f5b6db259ff20f95f1f72c0c2d24bcd1b61cb3ace8879de3f8788f1e68`. HTML SHA-256: `5319490f7243d72fdc8658730f5696ec209ca97b5f773f26787007889eab1425`. Actual HTTP readiness and exact HTML equality were verified before the final browser runs. The independent candidate process was stopped.

All **33 mocked browser tests** pass, as do both web CI jobs on `ea8ce95` ([run 34571040577](https://github.com/octos-org/octos-web/actions/runs/34571040577)).

Both **Chromium and WebKit running on mini3** pass the original six-turn conversation on initial open and two subsequent reloads, with the exact server transcript order, unique user turns and zero page errors. Results: [Chromium](evidence/2026-09-10-history-order/chromium-after.json), [WebKit](evidence/2026-09-10-history-order/webkit-after.json). The earlier failed run is retained above.

Both affected chat tabs in the existing native Safari profile were refreshed after deployment. All six turns remain visible in their original order; San Francisco is last, and the earlier Beijing question and answer each appear once. Neither authentication error is visible. [Sanitized Safari evidence](evidence/2026-09-10-history-order/existing-safari.json).

These checks certify the reported history-order repair. They do not extend the earlier soak duration or claim a new soak on this build.
