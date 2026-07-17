import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearToken } from "@/api/client";
import { listProjects, setArchived, toggleFavorite, useProjects } from "./project-store";

const SLIDES_ID = "slides-3000-aaaaaa";
const SITE_ID = "site-2000-bbbbbb";
const SESSION_ID = "web-4000-cccccc";
const UNPARSABLE_SESSION_ID = "web-nonsense-dddddd";

function seedSlides() {
  localStorage.setItem(
    "octos-slides-projects",
    JSON.stringify([
      {
        id: SLIDES_ID,
        title: "Quarterly Deck",
        createdAt: 3000,
        updatedAt: 3000,
        slides: [
          { index: 0, title: "Intro", notes: "", layout: "title" },
          { index: 1, title: "Numbers", notes: "", layout: "content" },
          { index: 2, title: "Roadmap", notes: "", layout: "content" },
          { index: 3, title: "Risks", notes: "", layout: "two-column" },
          { index: 4, title: "Close", notes: "", layout: "conclusion" },
        ],
        template: "business",
        tags: [],
        versions: [],
      },
    ]),
  );
}

function seedSites() {
  localStorage.setItem(
    "octos-sites-projects",
    JSON.stringify([
      {
        id: SITE_ID,
        title: "Signal Atlas",
        createdAt: 2000,
        updatedAt: 2000,
        preset: "astro",
        template: "astro-site",
        siteKind: "docs",
        slug: "signal-atlas",
      },
    ]),
  );
}

function seedSessions() {
  localStorage.setItem(
    "octos_session_titles",
    JSON.stringify({
      [SESSION_ID]: "Chat about physics",
      [UNPARSABLE_SESSION_ID]: "Session with unparsable id",
      "slides-999-zzzzzz": "Deck scaffold title (not a chat)",
      "random-id": "Also not a chat",
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("listProjects", () => {
  it("aggregates slides, sites, and web sessions sorted by updatedAt desc", () => {
    seedSlides();
    seedSites();
    seedSessions();

    const projects = listProjects();

    expect(projects.map((p) => p.id)).toEqual([
      SESSION_ID, // 4000
      SLIDES_ID, // 3000
      SITE_ID, // 2000
      UNPARSABLE_SESSION_ID, // falls back to 0 → last
    ]);

    const session = projects[0];
    expect(session.kind).toBe("studio");
    expect(session.title).toBe("Chat about physics");
    expect(session.updatedAt).toBe(4000);
    expect(session.meta).toBe("Studio session");
    expect(session.href).toBe(`/studio/${SESSION_ID}`);
    expect(session.favorite).toBe(false);
    expect(session.archived).toBe(false);

    const deck = projects[1];
    expect(deck.kind).toBe("slides");
    expect(deck.meta).toBe("5 slides · business");
    expect(deck.href).toBe(`/slides/${SLIDES_ID}`);

    const site = projects[2];
    expect(site.kind).toBe("site");
    expect(site.meta).toBe("docs · signal-atlas");
    expect(site.href).toBe(`/sites/${SITE_ID}`);
  });

  it("skips session title entries whose ids do not start with web-", () => {
    seedSessions();

    const projects = listProjects();

    expect(projects.every((p) => p.id.startsWith("web-"))).toBe(true);
    expect(projects.some((p) => p.id === "slides-999-zzzzzz")).toBe(false);
    expect(projects.some((p) => p.id === "random-id")).toBe(false);
  });

  it("removes identity-bound session projects immediately when the token clears", () => {
    seedSessions();
    localStorage.setItem("octos_current_session", SESSION_ID);
    localStorage.setItem("octos_session_stats", JSON.stringify({ [SESSION_ID]: {} }));
    localStorage.setItem("octos_session_topics", JSON.stringify({ [SESSION_ID]: "slides" }));
    localStorage.setItem("octos_deleted_sessions", JSON.stringify([SESSION_ID]));

    const { result, unmount } = renderHook(() => useProjects());
    expect(result.current.projects.some((project) => project.id === SESSION_ID)).toBe(true);

    act(() => clearToken());

    expect(result.current.projects.some((project) => project.id === SESSION_ID)).toBe(false);
    expect(localStorage.getItem("octos_session_titles")).toBeNull();
    expect(localStorage.getItem("octos_current_session")).toBeNull();
    expect(localStorage.getItem("octos_session_stats")).toBeNull();
    expect(localStorage.getItem("octos_session_topics")).toBeNull();
    expect(localStorage.getItem("octos_deleted_sessions")).toBeNull();
    unmount();
  });

  it("falls back to updatedAt 0 for web ids without a parsable timestamp", () => {
    seedSessions();

    const unparsable = listProjects().find(
      (p) => p.id === UNPARSABLE_SESSION_ID,
    );
    expect(unparsable).toBeDefined();
    expect(unparsable?.updatedAt).toBe(0);
  });

  it("lifts updatedAt to the local openedAt stamp so Recent reflects usage", async () => {
    seedSessions();
    const { recordProjectOpened } = await import("./project-store");
    const target = listProjects().find((p) => p.id.startsWith("web-"));
    expect(target).toBeDefined();

    const before = Date.now();
    recordProjectOpened(target!.id);

    const after = listProjects().find((p) => p.id === target!.id);
    expect(after?.updatedAt).toBeGreaterThanOrEqual(before);
    // And it now sorts first.
    expect(listProjects()[0]?.id).toBe(target!.id);
  });

  it("decodes backend-minted web-{uuid-v7} ids to their ms timestamp", () => {
    // uuid-v7 embeds the epoch ms in its first 48 bits; this one is
    // 0x019d044faa95 = 2026-03-19 (same fixture family as
    // sessionTimestamp() in session-context).
    const uuidId = "web-019d044f-aa95-7d92-8a5e-0123456789ab";
    localStorage.setItem(
      "octos_session_titles",
      JSON.stringify({ [uuidId]: "Server-minted session" }),
    );

    const project = listProjects().find((p) => p.id === uuidId);
    expect(project).toBeDefined();
    expect(project?.updatedAt).toBe(parseInt("019d044faa95", 16));
  });

  it("tolerates corrupted JSON in every source key", () => {
    localStorage.setItem("octos-slides-projects", "{not json");
    localStorage.setItem("octos-sites-projects", "{not json");
    localStorage.setItem("octos_session_titles", "{not json");
    localStorage.setItem("octos-project-flags", "{not json");

    expect(listProjects()).toEqual([]);
    expect(() => toggleFavorite(SLIDES_ID)).not.toThrow();
  });

  it("tolerates wrong-shape JSON (object where an array is expected)", () => {
    localStorage.setItem("octos-slides-projects", JSON.stringify({}));
    localStorage.setItem("octos-sites-projects", JSON.stringify({}));
    localStorage.setItem("octos_session_titles", JSON.stringify([1, 2, 3]));

    expect(listProjects()).toEqual([]);
  });
});

describe("favorite and archive flags", () => {
  it("toggleFavorite flips the flag and persists it to octos-project-flags", () => {
    seedSlides();

    toggleFavorite(SLIDES_ID);
    expect(listProjects().find((p) => p.id === SLIDES_ID)?.favorite).toBe(
      true,
    );

    const raw = localStorage.getItem("octos-project-flags");
    const flags = JSON.parse(raw ?? "{}") as Record<
      string,
      { favorite?: boolean; archived?: boolean }
    >;
    expect(flags[SLIDES_ID]?.favorite).toBe(true);

    toggleFavorite(SLIDES_ID);
    expect(listProjects().find((p) => p.id === SLIDES_ID)?.favorite).toBe(
      false,
    );
  });

  it("setArchived stores the archive flag without touching favorite", () => {
    seedSlides();

    toggleFavorite(SLIDES_ID);
    setArchived(SLIDES_ID, true);

    let deck = listProjects().find((p) => p.id === SLIDES_ID);
    expect(deck?.archived).toBe(true);
    expect(deck?.favorite).toBe(true);

    setArchived(SLIDES_ID, false);
    deck = listProjects().find((p) => p.id === SLIDES_ID);
    expect(deck?.archived).toBe(false);
    expect(deck?.favorite).toBe(true);
  });
});
