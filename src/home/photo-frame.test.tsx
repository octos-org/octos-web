import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoFrame } from "./photo-frame";

const photosMock = vi.hoisted(() => ({
  currentUrl: null as string | null,
}));

vi.mock("./use-photos", () => ({
  usePhotos: () => ({
    currentUrl: photosMock.currentUrl,
  }),
}));

describe("PhotoFrame", () => {
  beforeEach(() => {
    cleanup();
    photosMock.currentUrl = null;
  });

  it("shows an online landscape image when the user has not configured photos", () => {
    render(<PhotoFrame />);

    const image = screen.getByRole("img", { name: /landscape/i });
    expect(image.getAttribute("src")).toMatch(/^https:\/\/picsum\.photos\//);
    expect(screen.getByText("Add photos in Settings")).toBeTruthy();
  });
});
