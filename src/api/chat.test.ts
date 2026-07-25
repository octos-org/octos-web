/**
 * Unit tests for the M12 Phase D-4 follow-up: `uploadFiles()` must NOT
 * duplicate the 401/403 reaper from `request()`.
 *
 * Pre-follow-up `src/api/chat.ts:uploadFiles()` mirrored the old
 * `request()` behavior — on 401/403 it called `clearToken()` and hard-
 * redirected to `/login`. That contradicted D-4's promise that
 * blob/file ops propagate normal errors so the upload UI can render a
 * contextual retry control instead of nuking the user's tokens
 * mid-flow. These tests pin the new behavior: a 401/403 on `/api/upload`
 * leaves `TOKEN_KEY` and `ADMIN_TOKEN_KEY` intact and does NOT write
 * to `window.location.href`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { uploadFiles } from "@/api/chat";
import { TOKEN_KEY, ADMIN_TOKEN_KEY } from "@/lib/constants";

// ---------------------------------------------------------------------------
// jsdom location helpers (mirror src/api/client.test.ts)
// ---------------------------------------------------------------------------

const hrefWrites: string[] = [];
let originalLocation: Location | undefined;

function installLocationStub(pathname = "/app/dashboard"): void {
  hrefWrites.length = 0;
  if (!originalLocation) {
    originalLocation = window.location;
  }
  const stub = {
    pathname,
    hostname: "localhost",
    host: "localhost",
    protocol: "http:",
    origin: "http://localhost",
    search: "",
    hash: "",
    port: "",
    set href(value: string) {
      hrefWrites.push(value);
    },
    get href() {
      return `http://localhost${pathname}`;
    },
    assign: (value: string) => {
      hrefWrites.push(value);
    },
    replace: (value: string) => {
      hrefWrites.push(value);
    },
    reload: () => {},
    toString: () => `http://localhost${pathname}`,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).location;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).location = stub;
}

function restoreLocationStub(): void {
  if (originalLocation) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).location;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).location = originalLocation;
  }
}

function mockFetchStatus(status: number, body = ""): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body, {
      status,
      headers: { "content-type": "text/plain" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeFile(name = "a.txt", body = "x"): File {
  return new File([body], name, { type: "text/plain" });
}

beforeEach(() => {
  localStorage.setItem(TOKEN_KEY, "session-token");
  localStorage.setItem(ADMIN_TOKEN_KEY, "admin-token");
  installLocationStub("/app/dashboard");
});

afterEach(() => {
  restoreLocationStub();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uploadFiles — no duplicated 401/403 reaper (M12 Phase D-4 follow-up)", () => {
  it("401 from /api/upload → throws normal Error, preserves tokens, no redirect", async () => {
    mockFetchStatus(401, "upload session expired");

    let caught: unknown;
    try {
      await uploadFiles([makeFile()]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("upload session expired");

    // Tokens preserved — the structural cutover.
    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("admin-token");

    // No redirect.
    expect(hrefWrites.length).toBe(0);
  });

  it("403 from /api/upload → throws normal Error, preserves tokens, no redirect", async () => {
    mockFetchStatus(403, "forbidden");

    let caught: unknown;
    try {
      await uploadFiles([makeFile()]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("forbidden");

    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("admin-token");
    expect(hrefWrites.length).toBe(0);
  });

  it("500 from /api/upload → still throws, still preserves tokens", async () => {
    mockFetchStatus(500, "server on fire");

    await expect(uploadFiles([makeFile()])).rejects.toBeInstanceOf(Error);

    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("admin-token");
    expect(hrefWrites.length).toBe(0);
  });
});
