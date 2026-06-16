import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILIBILI_MUSIC_SCENES,
  buildBilibiliPlayerUrl,
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
    document.querySelectorAll("[data-octos-bilibili-audio]").forEach((node) => {
      node.remove();
    });
  });

  it("builds a Bilibili search URL from the scene keyword plus music", () => {
    expect(buildBilibiliSearchUrl("Cooking / Dinner")).toBe(
      "https://search.bilibili.com/all?keyword=Cooking%20%2F%20Dinner%20%E9%9F%B3%E4%B9%90",
    );
  });

  it("builds a hidden Bilibili player URL from a video URL", () => {
    expect(buildBilibiliPlayerUrl("https://www.bilibili.com/video/BV1cTcbzNE9p/")).toBe(
      "https://player.bilibili.com/player.html?bvid=BV1cTcbzNE9p&autoplay=1&danmaku=0&high_quality=1",
    );
  });

  it("starts Bilibili sound in a hidden in-page iframe without opening a window", async () => {
    window.open = vi.fn();
    const controller = createBilibiliMusicController({
      resolveFirstVideo: vi.fn().mockResolvedValue({
        title: "first result",
        url: "https://www.bilibili.com/video/BV1cTcbzNE9p/",
      }),
    });

    const result = await controller.playScene(BILIBILI_MUSIC_SCENES[1]);

    expect(window.open).not.toHaveBeenCalled();
    const frame = document.querySelector<HTMLIFrameElement>(
      "iframe[data-octos-bilibili-audio]",
    );
    expect(frame).not.toBeNull();
    expect(frame?.src).toBe(
      "https://player.bilibili.com/player.html?bvid=BV1cTcbzNE9p&autoplay=1&danmaku=0&high_quality=1",
    );
    expect(frame?.allow).toContain("autoplay");
    expect(result).toEqual({
      playing: true,
      fallback: false,
      title: "first result",
      url: "https://www.bilibili.com/video/BV1cTcbzNE9p/",
      embedUrl:
        "https://player.bilibili.com/player.html?bvid=BV1cTcbzNE9p&autoplay=1&danmaku=0&high_quality=1",
    });
  });

  it("uses the built-in default video when the resolver fails", async () => {
    window.open = vi.fn();
    const controller = createBilibiliMusicController({
      resolveFirstVideo: vi.fn().mockRejectedValue(new Error("blocked")),
    });

    const result = await controller.playScene(BILIBILI_MUSIC_SCENES[2]);

    expect(result.fallback).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
    expect(result.embedUrl).toContain("player.bilibili.com/player.html");
  });

  it("removes the hidden Bilibili iframe on stop", async () => {
    window.open = vi.fn();
    const controller = createBilibiliMusicController({
      resolveFirstVideo: vi.fn().mockResolvedValue(null),
    });

    await controller.playScene(BILIBILI_MUSIC_SCENES[0]);
    controller.stop();

    expect(document.querySelector("iframe[data-octos-bilibili-audio]")).toBeNull();
    expect(controller.getSnapshot().playing).toBe(false);
  });
});
