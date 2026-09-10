import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const fixture = "/tests/fixtures/review-correctness.html";
const subpath = "http://127.0.0.1:5177/app";

test("generated modules run without parent or top-level credential access; copied links are usable", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.addInitScript(() => { try { localStorage.setItem("octos_session_token", "synthetic-review-token"); } catch { /* opaque preview */ } });
  await context.route("**/api/my/preview/sign", (route) => route.fulfill({ json: {
    token: "signed-review", preview_url: "/api/preview-signed/signed-review/index.html", expires_at: new Date(Date.now() + 600_000).toISOString(),
  } }));
  await context.route("**/api/preview-signed/**", (route) => {
    const module = route.request().url().endsWith("module.js");
    return route.fulfill({
      // These are the paired server headers, covered by Rust handler tests.
      headers: { "Access-Control-Allow-Origin": "*", "Content-Security-Policy": "sandbox allow-scripts allow-forms", "Referrer-Policy": "no-referrer" },
      contentType: module ? "text/javascript" : "text/html",
      body: module
        ? `let parentRead = 'blocked', ownRead = 'blocked'; try { parentRead = parent.localStorage.getItem('octos_session_token'); } catch {} try { ownRead = localStorage.getItem('octos_session_token'); } catch {} document.body.dataset.parentRead = parentRead; document.body.dataset.ownRead = ownRead; document.body.dataset.ready = 'true';`
        : '<!doctype html><body>Generated preview<script type="module" src="./module.js"></script></body>',
    });
  });
  await page.goto(`${fixture}?mode=site`);
  const body = page.frameLocator("iframe").locator("body");
  await expect(body).toHaveAttribute("data-ready", "true");
  await expect(body).toHaveAttribute("data-parent-read", "blocked");
  await expect(body).toHaveAttribute("data-own-read", "blocked");
  await page.getByTitle("Copy preview URL", { exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe("http://127.0.0.1:5176/api/preview-signed/signed-review/index.html");
  const popupPromise = page.waitForEvent("popup");
  await page.getByTitle("Open preview in new tab").click();
  const popup = await popupPromise;
  await expect(popup.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(popup.locator("body")).toHaveAttribute("data-own-read", "blocked");
});

test("PPTX download authenticates and downloads the returned bytes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("octos_session_token", "review-download-token"));
  let authorization: string | undefined;
  await page.route("**/api/files/**", (route) => {
    authorization = route.request().headers().authorization;
    return route.fulfill({ status: authorization === "Bearer review-download-token" ? 200 : 401, body: "review-pptx-bytes" });
  });
  await page.goto(`${fixture}?mode=download`);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PPTX" }).click();
  const download = await downloadPromise;
  expect(authorization).toBe("Bearer review-download-token");
  expect(await readFile((await download.path())!, "utf8")).toBe("review-pptx-bytes");
});

test("download failures remain visible and can be retried", async ({ page }) => {
  await page.route("**/api/files/**", (route) => route.fulfill({ status: 401, body: "unauthorized" }));
  await page.goto(`${fixture}?mode=download`);
  await page.getByRole("button", { name: "Download PPTX" }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 401");
  await expect(page.getByRole("button", { name: "Download PPTX" })).toBeEnabled();
});

test("a real storage event revalidates the other tab before its next request", async ({ context, page }) => {
  await context.route("**/api/auth/status", (route) => route.fulfill({ json: {} }));
  await context.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: route.request().headers().authorization?.replace("Bearer ", "") }, portal: {} } }));
  let profileToken: string | undefined;
  await context.route("**/api/my/profile", (route) => { profileToken = route.request().headers().authorization; return route.fulfill({ json: {} }); });
  await page.goto(`${fixture}?mode=auth`);
  await page.evaluate(() => localStorage.setItem("octos_session_token", "review-account-a"));
  await page.reload();
  await expect(page.getByTestId("identity")).toContainText('"user":"review-account-a"');
  const second = await context.newPage();
  await second.goto(`${fixture}?mode=auth`);
  await second.getByRole("button", { name: "Switch account" }).click();
  await expect(page.getByTestId("identity")).toContainText('"user":"review-account-b"');
  await page.getByRole("button", { name: "Read profile" }).click();
  await expect.poll(() => profileToken).toBe("Bearer review-account-b");
});

test("voice capture starts with the real VAD assets under /app/", async ({ context, page }) => {
  await context.grantPermissions(["microphone"]);
  const assets: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => { if (response.url().includes("/vad/")) assets.push({ url: response.url(), status: response.status() }); });
  await page.goto(`${subpath}${fixture}?mode=voice`);
  await page.getByRole("button", { name: "Start capture" }).click();
  await expect(page.getByTestId("capturing")).toHaveText("true", { timeout: 45_000 });
  expect(assets.length).toBeGreaterThan(0);
  expect(assets.every((asset) => new URL(asset.url).pathname.startsWith("/app/vad/") && asset.status === 200)).toBe(true);
  await expect(page.getByTestId("capture-error")).toBeEmpty();
});

test("expired auth stays under /app/ and preserves a router-relative destination", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("octos_session_token", "review-expired"));
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 401, body: "unauthorized" }));
  await page.goto(`${subpath}${fixture}?mode=redirect`);
  const navigation = page.waitForRequest((request) => new URL(request.url()).pathname === "/app/login");
  await page.getByRole("button", { name: "Probe expired token" }).click();
  const destination = new URL((await navigation).url());
  expect(destination.searchParams.get("redirect")).toBe(`${fixture}?mode=redirect`);
});

test("the real launcher discovers saved server sessions in a fresh browser", async ({ page }) => {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem("octos_session_token", "review-existing-account"); });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === "/api/auth/me"
      ? { user: { id: "existing-user", name: "Existing User" }, portal: {}, profile_id: "existing-profile" }
      : path === "/api/auth/status" ? { email_login_enabled: true } : {} });
  });
  const methods: string[] = [];
  await page.routeWebSocket(/\/api\/ui-protocol\/ws/, (socket) => socket.onMessage((raw) => {
    const request = JSON.parse(raw.toString());
    methods.push(request.method);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "session/list"
      ? { sessions: [{ id: "web-existing-session", title: "Existing server project", message_count: 4 }] } : {} }));
  }));
  await page.goto("/");
  await expect(page.getByText("Existing server project", { exact: true })).toBeVisible();
  expect(methods).toContain("session/list");
});
