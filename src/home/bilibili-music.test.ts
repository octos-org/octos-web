import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILIBILI_MUSIC_SCENES,
  buildBilibiliSearchUrl,
  createBilibiliMusicController,
} from "./bilibili-music";

describe("bilibili music launcher", () => {
  const originalOpen = window.open;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it("builds a Bilibili search URL from the scene keyword plus music", () => {
    expect(buildBilibiliSearchUrl("Cooking / Dinner")).toBe(
      "https://search.bilibili.com/all?keyword=Cooking%20%2F%20Dinner%20%E9%9F%B3%E4%B9%90",
    );
  });

  it("opens the first resolved video in a named window", async () => {
    const popup = {
      closed: false,
      location: { href: "about:blank" },
      close: vi.fn(),
      focus: vi.fn(),
    };
    window.open = vi.fn(() => popup as unknown as Window);
    const controller = createBilibiliMusicController({
      resolveFirstVideo: vi.fn().mockResolvedValue({
        title: "first result",
        url: "https://www.bilibili.com/video/BV123/",
      }),
    });

    const result = await controller.playScene(BILIBILI_MUSIC_SCENES[1]);

    expect(window.open).toHaveBeenCalledWith(
      "about:blank",
      "octos-bilibili-music",
      "noopener=false,noreferrer=false",
    );
    expect(popup.location.href).toBe("https://www.bilibili.com/video/BV123/");
    expect(popup.focus).toHaveBeenCalled();
    expect(result).toEqual({
      opened: true,
      fallback: false,
      title: "first result",
      url: "https://www.bilibili.com/video/BV123/",
    });
  });

  it("falls back to the Bilibili search page when the resolver fails", async () => {
    const popup = {
      closed: false,
      location: { href: "about:blank" },
      close: vi.fn(),
      focus: vi.fn(),
    };
    window.open = vi.fn(() => popup as unknown as Window);
    const controller = createBilibiliMusicController({
      resolveFirstVideo: vi.fn().mockRejectedValue(new Error("blocked")),
    });

    const result = await controller.playScene(BILIBILI_MUSIC_SCENES[2]);

    expect(result.fallback).toBe(true);
    expect(popup.location.href).toBe(
      buildBilibiliSearchUrl(BILIBILI_MUSIC_SCENES[2].keyword),
    );
  });

  it("closes the owned Bilibili window on stop", async () => {
    const popup = {
      closed: false,
      location: { href: "about:blank" },
      close: vi.fn(() => {
        popup.closed = true;
      }),
      focus: vi.fn(),
    };
    window.open = vi.fn(() => popup as unknown as Window);
    const controller = createBilibiliMusicController({
      resolveFirstVideo: vi.fn().mockResolvedValue(null),
    });

    await controller.playScene(BILIBILI_MUSIC_SCENES[0]);
    controller.stop();

    expect(popup.close).toHaveBeenCalled();
    expect(controller.getSnapshot().playing).toBe(false);
  });
});
