import { useCallback, useRef, useState } from "react";

export interface CameraFrame {
  /** Whether the camera stream is live. */
  active: boolean;
  /** Live camera stream, for binding to a preview `<video>`. Null when off. */
  stream: MediaStream | null;
  /** Last error (permission denied / no device / capture failure). */
  error: string | null;
  /** Request camera access and start the stream. */
  start: () => Promise<boolean>;
  /** Stop the stream and release the device. */
  stop: () => void;
  /** Capture the current frame as a downscaled JPEG `File`, or `null` if the
   *  camera isn't active or capture fails (caller then sends audio only). */
  grabFrame: () => Promise<File | null>;
}

/** Longest edge of a captured frame, in px — caps vision-token cost + upload. */
export const MAX_LONG_EDGE = 768;
/** JPEG quality for captured frames. */
export const JPEG_QUALITY = 0.7;
/** Capture size used before the video reports its real dimensions. */
const FALLBACK_W = 640;
const FALLBACK_H = 480;

/** Target canvas size, downscaled so the longest edge is `maxEdge` (never
 *  upscaling). Exported for unit tests. */
export function computeDownscaledSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/**
 * Manage a single camera stream behind a tiny start/stop/grab interface.
 *
 * The stream is attached to an off-DOM `<video>` element (no preview is
 * rendered in the MVP); `grabFrame` paints the current frame onto an off-screen
 * canvas, downscales it, and returns a JPEG. Failures are swallowed into `null`
 * so a voice turn degrades to audio-only rather than breaking.
 */
export function useCameraFrame(): CameraFrame {
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [active, setActive] = useState(false);
  // Exposed so a preview <video> can bind the live stream.
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    const current = streamRef.current;
    streamRef.current = null;
    if (current) {
      for (const track of current.getTracks()) {
        try {
          track.stop();
        } catch {
          // already stopped
        }
      }
    }
    const video = videoRef.current;
    if (video) {
      try {
        video.srcObject = null;
      } catch {
        // ignore
      }
    }
    videoRef.current = null;
    setStream(null);
    setActive(false);
  }, []);

  const start = useCallback(async () => {
    if (streamRef.current) return true;
    setError(null);
    try {
      const md = navigator.mediaDevices;
      if (!md?.getUserMedia) throw new Error("camera unavailable");
      const stream = await md.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      try {
        await video.play?.();
      } catch {
        // Autoplay may be deferred; frames can still be grabbed once data flows.
      }
      videoRef.current = video;
      setStream(stream);
      setActive(true);
      return true;
    } catch (e) {
      console.error("[camera] start failed", e);
      setError(e instanceof Error ? e.message : "camera unavailable");
      setActive(false);
      streamRef.current = null;
      videoRef.current = null;
      setStream(null);
      return false;
    }
  }, []);

  const grabFrame = useCallback(async (): Promise<File | null> => {
    const video = videoRef.current;
    if (!video || !streamRef.current) return null;
    try {
      const w = video.videoWidth || FALLBACK_W;
      const h = video.videoHeight || FALLBACK_H;
      const size = computeDownscaledSize(w, h, MAX_LONG_EDGE);
      if (size.width === 0 || size.height === 0) return null;

      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, size.width, size.height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY);
      });
      if (!blob) return null;
      return new File([blob], `frame-${Date.now()}.jpg`, { type: "image/jpeg" });
    } catch (e) {
      console.error("[camera] grabFrame failed", e);
      return null;
    }
  }, []);

  return { active, stream, error, start, stop, grabFrame };
}
