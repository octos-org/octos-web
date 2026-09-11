import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverProjects } from "./project-discovery";
import { setToken } from "@/api/client";
import { getSlidesProject, upsertSlidesProject } from "@/slides/store";
import { getSiteProject } from "@/sites/store";

const mocks = vi.hoisted(() => ({ list: vi.fn(), slides: vi.fn(), site: vi.fn() }));
vi.mock("@/api/sessions", () => ({ listSessions: mocks.list }));
vi.mock("@/slides/api", () => ({ hydrateSlidesProjectFromSession: mocks.slides }));
vi.mock("@/sites/api", () => ({ hydrateSiteProjectFromSession: mocks.site }));

const deck = { id: "slides-existing", title: "Existing deck", scaffolded: true, slug: "existing", slides: [], template: "business", tags: [], versions: [], createdAt: 1, updatedAt: 1 };
beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); setToken("account-a"); });

describe("server project discovery", () => {
  it("restores chat, slides, and site indexes without a local project cache", async () => {
    mocks.list.mockResolvedValue([{ id: "web-existing", title: "Existing chat" }, { id: deck.id }, { id: "site-existing" }]);
    mocks.slides.mockResolvedValue(deck);
    mocks.site.mockResolvedValue({ id: "site-existing", title: "Existing site", createdAt: 1, updatedAt: 1 });
    await discoverProjects();
    expect(JSON.parse(localStorage.getItem("octos_session_titles")!)).toEqual({ "web-existing": "Existing chat" });
    expect(getSlidesProject(deck.id)?.title).toBe("Existing deck");
    expect(getSiteProject("site-existing")?.title).toBe("Existing site");
  });
  it("retains local edit state when a project is already known", async () => {
    upsertSlidesProject({ ...deck, title: "My local draft" });
    mocks.list.mockResolvedValue([{ id: deck.id }]);
    await discoverProjects();
    expect(mocks.slides).not.toHaveBeenCalled();
    expect(getSlidesProject(deck.id)?.title).toBe("My local draft");
  });
  it("cannot publish a previous account's late discovery result", async () => {
    let resolve!: (sessions: Array<{ id: string; title: string }>) => void;
    mocks.list.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = discoverProjects();
    setToken("account-b");
    resolve([{ id: "web-private-a", title: "Private account A" }]);
    await pending;
    expect(localStorage.getItem("octos_session_titles")).toBeNull();
  });
  it("starts fresh after same-token cache restoration and ignores the old result", async () => {
    let resolveOld!: (sessions: Array<{ id: string; title: string }>) => void;
    mocks.list.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const old = discoverProjects();
    window.dispatchEvent(new CustomEvent("crew:token_cleared"));
    mocks.list.mockResolvedValueOnce([{ id: "web-restored", title: "Restored" }]);
    await discoverProjects();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    resolveOld([{ id: "web-stale", title: "Stale" }]);
    await old;
    expect(JSON.parse(localStorage.getItem("octos_session_titles")!)).toEqual({ "web-restored": "Restored" });
  });
});
