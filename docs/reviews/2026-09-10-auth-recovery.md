# Session verification recovery on mini3

[Web #365](https://github.com/octos-org/octos-web/issues/365) follows a user report of “Unable to verify your session. Check your connection and retry.”

At inspection, both the isolated app and `/api/auth/me` with the current synthetic test account returned HTTP 200. Two older synthetic account tokens returned 401. The user's exact failing request and token were not available, so those observations do not establish token expiry or a server outage as the cause of their error. The matching local Safari app tab was reloaded, including after deployment of the fix; its rendered login state could not be directly inspected through Safari automation.

The later [Safari investigation](2026-09-10-malformed-auth.md) accessed the existing tab's rendered text and confirmed a malformed saved credential rejected by the browser's HTTP-header validation. That root cause is tracked separately in #366 and supersedes the initial uncertainty; this record retains the narrower transient-recovery work and its original evidence.

The reproducible product gap is that one temporary validation failure leaves the app on the error page until manual intervention, even after the service is reachable again. The page also lacked a route to choose another login.

## Change

Web `db948a4` retries failed validation after one second and, if necessary, three more seconds. Automatic attempts stop after two retries. Returning online triggers another verification. A successful verification clears the error, and identity changes cancel stale recovery work. Transient failures preserve the saved credential; actual 401/403 responses retain the existing rejection/logout behavior.

The error page exposes **Retry** and **Sign in again**. The latter navigates to login while preserving the original route, query and fragment under `/app/`; merely opening it does not revoke a valid session.

## Verification

- 20 focused tests pass, including automatic recovery, bounded persistent failures, online recovery, preserved credentials and the sign-in return route. An initial fake-timer regression caught React batching two loading updates together and suppressing a retry; a state-driven retry count fixes that case.
- All **1,253 unit tests** and **33 mocked browser tests** pass. The production `/app/` build passes. Lint reports zero errors and 105 warnings, including one new effect-state warning for resetting the bounded retry count.
- Both web CI jobs pass on the deployed runtime in [run 34563427729](https://github.com/octos-org/octos-web/actions/runs/34563427729).

The isolated runtime embeds web **`db948a4`** / core **`7590b73`**, PID **20519**, binary SHA-256 `45ab2856477f4ea750bfcef3b56a75d13bd57f3e17bb4934a27989d19c206fae`, HTML SHA-256 `a109c3b4c82ab0ac12eba4becceb3b5ceac2d00805196171c4b072f167d77a7e`. HTTP 200 and exact built/served HTML equality were checked before browser testing. No provider or authentication configuration was changed.

The reusable [`auth-recovery.mjs`](../../scripts/live-review/auth-recovery.mjs) runner executes on mini3 itself. It injects connection failures only by aborting selected validation requests; successful authentication and invalid-token rejection use the actual server. It does not fabricate successful API responses or revoke the valid test account's token. `OCTOS_LIVE_REVIEW_BROWSER=webkit` selects WebKit instead of Chromium.

Chromium and WebKit both pass all three scenarios with zero page errors: two failed probes followed by actual successful authentication; persistent failure bounded to three probes during the observation window, followed by successful sign-in with the destination retained; and an actual 401 returning an invalid-token browser to login. WebKit 26.4 is the Playwright engine, not direct automation of the user's existing Safari profile.

Actual results: [Chromium](evidence/2026-09-10-auth-recovery/chromium-results.json), [WebKit](evidence/2026-09-10-auth-recovery/webkit-results.json). Inspected error-state screenshots: [Chromium](evidence/2026-09-10-auth-recovery/chromium-persistent-outage.png), [WebKit](evidence/2026-09-10-auth-recovery/webkit-persistent-outage.png). Recovery screenshots are retained alongside the results.

These are targeted authentication checks. The previously completed 30-minute soak remains pinned to its earlier runtime, and this does not certify all other application features.
