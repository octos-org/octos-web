import { useEffect, useRef } from "react";
import {
  DEFAULT_CAMERA_FRAME_SETTINGS,
  drawCameraFrame,
  type CameraFrameSettings,
} from "./use-camera-frame";

/**
 * Exact self-preview of the transformed frame sent to the model.
 */
export function CameraPreview({
  stream,
  settings = DEFAULT_CAMERA_FRAME_SETTINGS,
  maxLongEdge = 320,
  className = "",
}: {
  stream: MediaStream | null;
  settings?: CameraFrameSettings;
  maxLongEdge?: number;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    video.srcObject = stream;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (stream) {
      const p = video.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
      scratchRef.current ??= document.createElement("canvas");
      const paint = () => {
        drawCameraFrame(
          video,
          canvas,
          settings,
          maxLongEdge,
          scratchRef.current ?? undefined,
        );
      };
      paint();
      timer = setInterval(paint, 100);
    }
    return () => {
      if (timer !== undefined) clearInterval(timer);
    };
  }, [maxLongEdge, settings, stream]);

  return (
    <>
      <video ref={videoRef} autoPlay muted playsInline hidden />
      <canvas
        ref={canvasRef}
        data-testid="camera-preview"
        className={`h-24 max-w-48 rounded-xl ring-1 ring-white/15 shadow-lg ${className}`}
      />
    </>
  );
}
