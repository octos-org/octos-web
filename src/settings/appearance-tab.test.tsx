import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OctosTeacher } from "@/learning/octos-teacher";
import { AppearanceTab } from "./appearance-tab";

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({
    theme: "light",
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
    uiStyle: "ivory-obsidian",
    setUiStyle: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-layout", () => ({
  useLayout: () => ({ layout: "classic", setLayout: vi.fn() }),
}));

describe("AppearanceTab learning companion skins", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("offers SVG and 3D presets and updates the live learning companion preference", () => {
    render(
      <>
        <AppearanceTab />
        <OctosTeacher state="idle" speech="" onClick={vi.fn()} />
      </>,
    );

    expect(screen.getAllByTestId(/^teacher-skin-(?!active-)/)).toHaveLength(7);
    expect(screen.getAllByText("3D · Animated")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "Ocean Octos skin" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Starlight Octos skin" }));

    expect(localStorage.getItem("octos-teacher-skin")).toBe("starlight");
    expect(
      screen.getByRole("button", { name: "和 Octos 说话" })
        .querySelector(".octos-avatar-art")
        ?.getAttribute("data-skin"),
    ).toBe("starlight");
  });

  it("reserves the active badge slot and persists a selected 3D model skin", () => {
    render(<AppearanceTab />);

    const oceanBadge = screen.getByTestId("teacher-skin-active-ocean");
    const pandaBadge = screen.getByTestId("teacher-skin-active-panda-3d");
    expect(oceanBadge.className).not.toContain("invisible");
    expect(pandaBadge.className).toContain("invisible");

    fireEvent.click(screen.getByRole("button", { name: "Panda Pal Octos skin" }));

    expect(localStorage.getItem("octos-teacher-skin")).toBe("panda-3d");
    expect(
      screen.getByRole("button", { name: "Panda Pal Octos skin" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(oceanBadge.className).toContain("invisible");
    expect(pandaBadge.className).not.toContain("invisible");
  });

  it("responds immediately when the learning companion is tapped", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(<OctosTeacher state="idle" speech="" onClick={onClick} />);

    const teacher = screen.getByRole("button", { name: "和 Octos 说话" });
    fireEvent.click(teacher);

    expect(onClick).toHaveBeenCalledOnce();
    expect(teacher.getAttribute("data-reacting")).toBe("true");
    expect(teacher.querySelector(".octos-teacher-reaction")).not.toBeNull();

    act(() => vi.advanceTimersByTime(760));
    expect(teacher.getAttribute("data-reacting")).toBeNull();
  });
});
