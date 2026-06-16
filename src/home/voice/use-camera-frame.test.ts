import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeDownscaledSize, useCameraFrame } from "./use-camera-frame";

describe("computeDownscaledSize", () => {
  it("downscales landscape so the long edge is the cap", () => {
    expect(computeDownscaledSize(1920, 1080, 768)).toEqual({
      width: 768,
      height: 432,
    });
  });

  it("downscales portrait so the long edge is the cap", () => {
    expect(computeDownscaledSize(1080, 1920, 768)).toEqual({
      width: 432,
      height: 768,
    });
  });

  it("never upscales a frame smaller than the cap", () => {
    expect(computeDownscaledSize(640, 480, 768)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("returns zero for empty dimensions", () => {
    expect(computeDownscaledSize(0, 0, 768)).toEqual({ width: 0, height: 0 });
  });
});

describe("useCameraFrame", () => {
  const getUserMedia = vi.fn();

  beforeEach(() => {
    getUserMedia.mockReset();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      cb: BlobCallback,
    ) {
      cb(new Blob(["x"], { type: "image/jpeg" }));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null from grabFrame when the camera is not started", async () => {
    const { result } = renderHook(() => useCameraFrame());
    await expect(result.current.grabFrame()).resolves.toBeNull();
  });

  it("returns a jpeg File from grabFrame when active", async () => {
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    const { result } = renderHook(() => useCameraFrame());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.active).toBe(true);

    const frame = await result.current.grabFrame();
    expect(frame).toBeInstanceOf(File);
    expect(frame?.type).toBe("image/jpeg");
  });

  it("sets error and stays inactive when permission is denied", async () => {
    getUserMedia.mockRejectedValue(new Error("Permission denied"));
    const { result } = renderHook(() => useCameraFrame());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("Permission denied");
  });

  it("stops the media tracks on stop()", async () => {
    const stopTrack = vi.fn();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    const { result } = renderHook(() => useCameraFrame());

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.stop();
    });

    expect(stopTrack).toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });
});
