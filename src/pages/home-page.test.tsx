import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unlockAudioMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/studio-nav", () => ({
  StudioNav: ({ actions }: { actions?: React.ReactNode }) => (
    <nav data-testid="studio-nav">{actions}</nav>
  ),
}));

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({
    theme: "light" as const,
    uiStyle: "ivory-obsidian" as const,
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
    setUiStyle: vi.fn(),
  }),
}));

vi.mock("@/home/use-ominix-runtime-summary", () => ({
  useOminixRuntimeSummary: () => ({
    label: "Voice engine ready",
    tone: "success" as const,
    ready: true,
    loading: false,
    canRepair: false,
    state: "ready",
    needsAttention: false,
    refresh: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/auth/auth-context", () => ({
  useAuth: () => ({
    user: { email: "test@example.com" },
    portal: null,
    logout: vi.fn(),
  }),
}));

vi.mock("@/home/voice/audio-playback", () => ({
  unlockAudio: unlockAudioMock,
}));

import { HomePage } from "./home-page";

const SLIDES_ID = "slides-1700000000000-fixdek";
const SESSION_ID = "web-1700000100000-fixcht";

function seedFixtures() {
  localStorage.setItem(
    "octos-slides-projects",
    JSON.stringify([
      {
        id: SLIDES_ID,
        title: "Quarterly Deck",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        slides: [{ index: 0, title: "Intro", notes: "", layout: "title" }],
        template: "business",
        tags: [],
        versions: [],
      },
    ]),
  );
  localStorage.setItem(
    "octos_session_titles",
    JSON.stringify({ [SESSION_ID]: "Favorite chat session" }),
  );
  localStorage.setItem(
    "octos-project-flags",
    JSON.stringify({ [SESSION_ID]: { favorite: true } }),
  );
}

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  seedFixtures();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("HomePage (Ivory Obsidian launcher)", () => {
  it("renders the hero, create card, and the design's three tabs", () => {
    renderHome();

    expect(screen.getByRole("heading", { name: "Octos Home" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /create new project/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "All Projects" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Shared with Me" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    // The nav hosts the design's Create Project action.
    expect(screen.getByRole("button", { name: "Create Project" })).toBeTruthy();
  });

  it("reveals the three chooser tiles when the create card is clicked", () => {
    renderHome();

    // Role queries: project-card chips also contain "Studio session" text.
    expect(
      screen.queryByRole("button", { name: "Studio session" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Slide deck" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Site" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /create new project/i }),
    );

    expect(
      screen.getByRole("button", { name: "Studio session" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slide deck" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Site" })).toBeTruthy();
  });

  it("renders project cards from localStorage fixtures", () => {
    renderHome();

    expect(screen.getByText("Quarterly Deck")).toBeTruthy();
    // The favorite session shows in both Recent and Favorite Projects.
    expect(
      screen.getAllByText("Favorite chat session").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("favorites a project via the card's overflow menu and persists it", () => {
    renderHome();

    const deckCard = screen
      .getByText("Quarterly Deck")
      .closest('[role="button"]');
    expect(deckCard).not.toBeNull();

    fireEvent.click(
      within(deckCard as HTMLElement).getByRole("button", {
        name: "Project options for Quarterly Deck",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Favorite" }));

    const flags = JSON.parse(
      localStorage.getItem("octos-project-flags") ?? "{}",
    ) as Record<string, { favorite?: boolean; archived?: boolean }>;
    expect(flags[SLIDES_ID]?.favorite).toBe(true);
    // The pre-seeded favorite flag on the chat session is untouched.
    expect(flags[SESSION_ID]?.favorite).toBe(true);

    // The deck now also appears in Favorite Projects with the filled star.
    const favoriteStars = screen.getAllByRole("button", {
      name: "Remove from favorites",
    });
    expect(favoriteStars.length).toBeGreaterThanOrEqual(2);
  });

  it("archives via the menu and shows the project under the Archive tab", () => {
    renderHome();

    const deckCard = screen
      .getByText("Quarterly Deck")
      .closest('[role="button"]');
    fireEvent.click(
      within(deckCard as HTMLElement).getByRole("button", {
        name: "Project options for Quarterly Deck",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    // Gone from All Projects…
    expect(screen.queryByText("Quarterly Deck")).toBeNull();

    // …and listed under Archive.
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText("Quarterly Deck")).toBeTruthy();
  });

  it("unfavorites via the favorites-grid star", () => {
    renderHome();

    // The seeded favorite session renders a filled star in Favorites.
    const stars = screen.getAllByRole("button", {
      name: "Remove from favorites",
    });
    fireEvent.click(stars[0]);

    const flags = JSON.parse(
      localStorage.getItem("octos-project-flags") ?? "{}",
    ) as Record<string, { favorite?: boolean }>;
    expect(flags[SESSION_ID]?.favorite).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Remove from favorites" }),
    ).toBeNull();
  });

  it("restores an archived project via its menu", () => {
    localStorage.setItem(
      "octos-project-flags",
      JSON.stringify({ [SLIDES_ID]: { archived: true } }),
    );
    renderHome();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    const card = screen
      .getByText("Quarterly Deck")
      .closest('[role="button"]');
    fireEvent.click(
      within(card as HTMLElement).getByRole("button", {
        name: "Project options for Quarterly Deck",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore" }));

    const flags = JSON.parse(
      localStorage.getItem("octos-project-flags") ?? "{}",
    ) as Record<string, { archived?: boolean }>;
    expect(flags[SLIDES_ID]?.archived).toBe(false);
    expect(screen.getByText("No archived projects yet.")).toBeTruthy();
  });

  it("shows the Shared with Me placeholder", () => {
    renderHome();

    fireEvent.click(screen.getByRole("button", { name: "Shared with Me" }));
    expect(screen.getByText(/Nothing shared yet/)).toBeTruthy();
  });
});
