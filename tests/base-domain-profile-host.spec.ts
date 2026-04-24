import { expect, test } from "@playwright/test";
import { inferProfileIdFromHostname } from "../src/api/client";

// `inferProfileIdFromHostname` drives the web client's per-profile
// routing on public deploys. When a mini serves profiles under a base
// domain other than `crew.ominix.io` (e.g. mini2's `bot.ominix.io`),
// the suffix list must cover that domain or every page loads against
// a null profile id — which is exactly the defect this PR fixes.

test("inferProfileIdFromHost accepts crew suffix for backward compat", () => {
  expect(inferProfileIdFromHostname("dspfac.crew.ominix.io")).toBe("dspfac");
});

test("inferProfileIdFromHost_accepts_ocean_suffix", () => {
  // mini5 serves profiles under ocean.ominix.io — before the fix this
  // returned null and the web client lost per-profile context.
  expect(inferProfileIdFromHostname("dspfac.ocean.ominix.io")).toBe("dspfac");
});

test("inferProfileIdFromHost_accepts_bot_suffix", () => {
  // mini2 case.
  expect(inferProfileIdFromHostname("acme.bot.ominix.io")).toBe("acme");
});

test("inferProfileIdFromHost accepts octos suffix", () => {
  expect(inferProfileIdFromHostname("newsbot.octos.ominix.io")).toBe(
    "newsbot",
  );
});

test("inferProfileIdFromHost strips reserved root subdomains", () => {
  // Root landing pages (`crew.`, `bot.`, `octos.`, `ocean.`, `www`)
  // must NOT be treated as profile ids — otherwise the web client
  // tries to act on behalf of a nonexistent "crew" profile when the
  // user visits the marketing root.
  expect(inferProfileIdFromHostname("crew.ominix.io")).toBeNull();
  expect(inferProfileIdFromHostname("bot.ominix.io")).toBeNull();
  expect(inferProfileIdFromHostname("octos.ominix.io")).toBeNull();
  expect(inferProfileIdFromHostname("ocean.ominix.io")).toBeNull();
});

test("inferProfileIdFromHost returns null for unrelated hosts", () => {
  expect(inferProfileIdFromHostname("example.com")).toBeNull();
  expect(inferProfileIdFromHostname("localhost")).toBeNull();
  // A subdomain of a domain we don't own must never be claimed.
  expect(inferProfileIdFromHostname("dspfac.evil.com")).toBeNull();
});
