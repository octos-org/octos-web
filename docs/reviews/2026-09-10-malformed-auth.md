# Confirmed Safari sign-in failure: malformed saved credential

[Web #366](https://github.com/octos-org/octos-web/issues/366) identifies the cause of the reported login failure in the user's existing Safari profile.

## Actual browser evidence and recovery

Safari's existing `/app/login` tab displayed “Can't reach the server to load the sign-in options.” Opening `/api/auth/status` in that same Safari profile returned valid JSON. An origin-local diagnostic then exercised the request paths directly: anonymous fetch returned HTTP 200 and valid JSON; constructing the existing `Authorization` header threw `TypeError`, and the equivalent authenticated fetch also failed before network transmission. The saved credential had 1,039 characters. Its value was not exported or included in evidence. `Content-Type` and `X-Search-Engine` passed header validation.

This was a malformed stored credential, not evidence that mini3 was stopped. The first recovery change ([#365](https://github.com/octos-org/octos-web/issues/365)) improved transient-failure recovery but did not address this cause.

For immediate recovery, only the malformed credential entry was removed from that Safari origin. The valid review credential was then entered through the actual Safari password field and Login action, with the target origin and password-field placeholder checked before typing. Safari entered `/app/chat`, displayed the `review-a` principal and saved conversation history, and no longer displayed either authentication error. The temporary loopback diagnostic proxy was removed and the original SSH-forward arrangement restored. Other browser data and server authentication configuration were preserved.

## Fix

- `auth.status()` now uses the public request helper. Loading sign-in methods does not attach a saved credential, profile header or search preference, and is not invalidated by an unrelated token change while the response is in flight.
- Token entry validates whether its value can form an HTTP authorization header before replacing a working credential or moving any local work into an account archive. Invalid input receives a format error at the login form.
- A malformed saved token is classified as rejected credentials before fetch, allowing the existing authentication handler to return the user to sign-in. It no longer masquerades as a network outage.
- Authentication requests omit the unrelated search-preference header.

## Verification

The five new regressions cover malformed saved credentials/preferences, a concurrent token-clear/status-response race, preserving an existing login and private local work on invalid input, malformed-token classification, and authentication without unrelated preferences. **52 focused tests** and all **1,258 unit tests** pass. The production `/app/` build passes.

The actual Safari recovery above used the existing browser profile. The reusable [`auth-recovery.mjs`](../../scripts/live-review/auth-recovery.mjs) adds a separate synthetic malformed-state case for Chromium and WebKit: a damaged saved token must reach a working login form, an invalid paste must receive the format error, and a valid credential must then authenticate against the actual server.

The isolated mini3 server now embeds web **`b28f36a`** / core **`7590b73`**, PID **22478**. The binary SHA-256 is `107ed8b773e7eefce324d0a8c1aedb0447d050adf7c5801e2ca775f26b5533fa`; the served HTML SHA-256 is `472c5a5b519d213593eaa0d5383fef6d115b51cf65dea68979a3ebe207f9bf9f`. HTTP readiness and exact built/served HTML equality were checked before browser testing.

Both **Chromium and WebKit running on mini3 pass all four cases**, with zero page errors: automatic recovery after two injected validation disconnects; bounded persistent-outage recovery through sign-in with the destination preserved; actual server rejection of an invalid credential; and malformed saved/pasted credential recovery through a valid real login. Only validation disconnects are injected; authentication responses come from the actual server. Results: [Chromium](evidence/2026-09-10-malformed-auth/chromium-results.json), [WebKit](evidence/2026-09-10-malformed-auth/webkit-results.json).

After deployment, a new protected chat tab in the same existing Safari profile also displayed the authenticated principal and saved history without either error. The [sanitized Safari record](evidence/2026-09-10-malformed-auth/existing-safari.json) records the diagnosis and recovery without a token value.

All **33 mocked browser regressions** pass. Lint reports **zero errors and 105 warnings**, unchanged from the preceding auth-recovery build. Both web CI jobs pass on `b28f36a` ([run 34567549696](https://github.com/octos-org/octos-web/actions/runs/34567549696)). These authentication checks do not extend the earlier soak's duration or attribute it to this newer build.
