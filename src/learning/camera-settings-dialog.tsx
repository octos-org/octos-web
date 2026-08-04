import {
  CameraOff,
  FlipHorizontal2,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { CameraPreview } from "@/home/voice/camera-preview";
import type {
  CameraFrameSettings,
  CameraRotation,
} from "@/home/voice/use-camera-frame";

export function CameraSettingsDialog({
  stream,
  settings,
  error,
  temporaryPreview,
  onChange,
  onReset,
  onClose,
}: {
  stream: MediaStream | null;
  settings: CameraFrameSettings;
  error: string | null;
  temporaryPreview: boolean;
  onChange: (patch: Partial<CameraFrameSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <div
      className="learning-camera-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="learning-camera-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="learning-camera-dialog-title"
      >
        <header className="learning-camera-dialog-header">
          <div>
            <span>Camera framing</span>
            <h2 id="learning-camera-dialog-title">调整老师看到的画面</h2>
            <p>这里的方向、缩放和取景会原样应用到发送给老师的图片。</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="关闭摄像头画面设置"
          >
            <X size={22} />
          </button>
        </header>

        <div className="learning-camera-dialog-body">
          <div className="learning-camera-dialog-preview">
            {stream ? (
              <CameraPreview
                stream={stream}
                settings={settings}
                maxLongEdge={960}
                className="learning-camera-dialog-canvas"
              />
            ) : (
              <div className="learning-camera-dialog-placeholder">
                <CameraOff size={34} />
                <strong>摄像头预览不可用</strong>
                <span>{error ?? "仍可先设置方向和清晰度，启用摄像头后即可预览。"}</span>
              </div>
            )}
            <div className="learning-camera-dialog-preview-label">
              <strong>老师看到的画面</strong>
              <span>{settings.rotation}° · {settings.zoom.toFixed(1)}×</span>
            </div>
            {temporaryPreview && (
              <p className="learning-camera-dialog-privacy">
                摄像头仅用于本次调整，关闭窗口后会自动停止。
              </p>
            )}
          </div>

          <div className="learning-camera-dialog-controls">
            <div className="learning-camera-dialog-actions">
              <button
                type="button"
                aria-label="向左旋转摄像头画面"
                onClick={() => onChange({
                  rotation: ((settings.rotation + 270) % 360) as CameraRotation,
                })}
              >
                <RotateCcw size={19} />
                <span>左转</span>
              </button>
              <button
                type="button"
                aria-label="向右旋转摄像头画面"
                onClick={() => onChange({
                  rotation: ((settings.rotation + 90) % 360) as CameraRotation,
                })}
              >
                <RotateCw size={19} />
                <span>右转</span>
              </button>
              <button
                type="button"
                aria-label="镜像摄像头画面"
                aria-pressed={settings.mirror}
                onClick={() => onChange({ mirror: !settings.mirror })}
              >
                <FlipHorizontal2 size={19} />
                <span>镜像</span>
              </button>
            </div>

            <label className="learning-camera-dialog-slider">
              <span>缩放</span>
              <input
                aria-label="摄像头画面缩放"
                type="range"
                min="1"
                max="3"
                step="0.1"
                value={settings.zoom}
                onChange={(event) => onChange({ zoom: Number(event.target.value) })}
              />
              <output>{settings.zoom.toFixed(1)}×</output>
            </label>
            <label className="learning-camera-dialog-slider">
              <span>左右</span>
              <input
                aria-label="摄像头画面水平位置"
                type="range"
                min="-1"
                max="1"
                step="0.05"
                value={settings.offsetX}
                disabled={settings.zoom === 1}
                onChange={(event) => onChange({ offsetX: Number(event.target.value) })}
              />
              <output>{Math.round(settings.offsetX * 100)}</output>
            </label>
            <label className="learning-camera-dialog-slider">
              <span>上下</span>
              <input
                aria-label="摄像头画面垂直位置"
                type="range"
                min="-1"
                max="1"
                step="0.05"
                value={settings.offsetY}
                disabled={settings.zoom === 1}
                onChange={(event) => onChange({ offsetY: Number(event.target.value) })}
              />
              <output>{Math.round(settings.offsetY * 100)}</output>
            </label>

            <button
              type="button"
              className="learning-camera-dialog-document-mode"
              aria-pressed={settings.documentMode}
              onClick={() => onChange({ documentMode: !settings.documentMode })}
            >
              <span>
                <strong>试卷清晰模式</strong>
                <small>提高发送分辨率与文字清晰度</small>
              </span>
              <b>{settings.documentMode ? "已开启" : "已关闭"}</b>
            </button>

            <button
              type="button"
              className="learning-camera-dialog-reset"
              onClick={onReset}
            >
              <RotateCcw size={16} />
              恢复默认取景
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
