import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeCameraFrameGeometry,
  computeDownscaledSize,
  DEFAULT_CAMERA_FRAME_SETTINGS,
  DOCUMENT_JPEG_QUALITY,
  drawCameraFrame,
  useCameraFrame,
} from "./use-camera-frame";

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

describe("computeCameraFrameGeometry", () => {
  it("swaps the output dimensions after a quarter turn", () => {
    expect(
      computeCameraFrameGeometry(1920, 1080, {
        ...DEFAULT_CAMERA_FRAME_SETTINGS,
        rotation: 90,
      }),
    ).toEqual({
      rotatedWidth: 1080,
      rotatedHeight: 1920,
      cropX: 0,
      cropY: 0,
      cropWidth: 1080,
      cropHeight: 1920,
    });
  });

  it("zooms and pans within the rotated image bounds", () => {
    expect(
      computeCameraFrameGeometry(1000, 800, {
        ...DEFAULT_CAMERA_FRAME_SETTINGS,
        zoom: 2,
        offsetX: 1,
        offsetY: -1,
      }),
    ).toEqual({
      rotatedWidth: 1000,
      rotatedHeight: 800,
      cropX: 500,
      cropY: 0,
      cropWidth: 500,
      cropHeight: 400,
    });
  });
});

describe("useCameraFrame", () => {
  const getUserMedia = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    getUserMedia.mockReset();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      restore: vi.fn(),
      rotate: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
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

    let started = false;
    await act(async () => {
      started = await result.current.start();
    });
    expect(started).toBe(true);
    expect(result.current.active).toBe(true);

    const frame = await result.current.grabFrame();
    expect(frame).toBeInstanceOf(File);
    expect(frame?.type).toBe("image/jpeg");
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/jpeg",
      DOCUMENT_JPEG_QUALITY,
    );
    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  });

  it("mirrors the final displayed orientation after rotating", () => {
    const operations: string[] = [];
    const context = {
      drawImage: vi.fn(),
      restore: vi.fn(),
      rotate: vi.fn(() => operations.push("rotate")),
      save: vi.fn(),
      scale: vi.fn(() => operations.push("mirror")),
      translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);

    const painted = drawCameraFrame(
      document.createElement("video"),
      document.createElement("canvas"),
      {
        ...DEFAULT_CAMERA_FRAME_SETTINGS,
        rotation: 90,
        mirror: true,
      },
      320,
    );

    expect(painted).toBe(true);
    expect(operations).toEqual(["mirror", "rotate"]);
  });

  it("sets error and stays inactive when permission is denied", async () => {
    getUserMedia.mockRejectedValue(new Error("Permission denied"));
    const { result } = renderHook(() => useCameraFrame());

    let started = true;
    await act(async () => {
      started = await result.current.start();
    });

    expect(started).toBe(false);
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

  it("exposes the live stream while active and clears it on stop", async () => {
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
    getUserMedia.mockResolvedValue(fakeStream);
    const { result } = renderHook(() => useCameraFrame());

    expect(result.current.stream).toBeNull();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.stream).toBe(fakeStream);

    act(() => {
      result.current.stop();
    });
    expect(result.current.stream).toBeNull();
  });

  it("reuses an active stream instead of requesting the camera twice", async () => {
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
    getUserMedia.mockResolvedValue(fakeStream);
    const { result } = renderHook(() => useCameraFrame());

    await act(async () => {
      expect(await result.current.start()).toBe(true);
      expect(await result.current.start()).toBe(true);
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
