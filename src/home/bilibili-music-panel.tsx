import { ExternalLink, Music, Square, X } from "lucide-react";
import { useMemo, useState } from "react";

import {
  BILIBILI_MUSIC_SCENES,
  type BilibiliMusicSnapshot,
  createBilibiliMusicController,
} from "./bilibili-music";

interface BilibiliMusicPanelProps {
  open: boolean;
  onClose: () => void;
}

export function BilibiliMusicPanel({ open, onClose }: BilibiliMusicPanelProps) {
  const controller = useMemo(() => createBilibiliMusicController(), []);
  const [snapshot, setSnapshot] = useState<BilibiliMusicSnapshot>(
    controller.getSnapshot(),
  );
  const [busyScene, setBusyScene] = useState<string | null>(null);

  if (!open) return null;

  const playScene = async (sceneId: string) => {
    const scene = BILIBILI_MUSIC_SCENES.find((item) => item.id === sceneId);
    if (!scene) return;
    setBusyScene(scene.id);
    await controller.playScene(scene);
    setSnapshot(controller.getSnapshot());
    setBusyScene(null);
  };

  const stop = () => {
    controller.stop();
    setSnapshot(controller.getSnapshot());
  };

  return (
    <div
      className="home-music-panel"
      role="dialog"
      aria-modal="false"
      aria-label="Bilibili music"
    >
      <div className="home-music-panel-header">
        <div className="flex items-center gap-3">
          <span className="home-music-panel-icon">
            <Music size={20} />
          </span>
          <div>
            <h2 className="text-lg font-semibold leading-tight text-white">
              Bilibili Music
            </h2>
            <p className="text-sm text-white/45">
              {snapshot.playing
                ? snapshot.fallback
                  ? "Search opened"
                  : "Video opened"
                : "Pick a scene"}
            </p>
          </div>
        </div>
        <button
          className="home-music-icon-button"
          type="button"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>

      <div className="home-music-scene-grid">
        {BILIBILI_MUSIC_SCENES.map((scene) => (
          <button
            key={scene.id}
            type="button"
            className="home-music-scene-button"
            onClick={() => void playScene(scene.id)}
            disabled={busyScene !== null}
          >
            <span>{busyScene === scene.id ? "Opening..." : scene.label}</span>
            <ExternalLink size={16} />
          </button>
        ))}
      </div>

      <div className="home-music-panel-footer">
        <div className="min-w-0">
          <p className="truncate text-sm text-white/70">
            {snapshot.scene?.label ?? "No Bilibili window"}
          </p>
          <p className="truncate text-xs text-white/35">
            {snapshot.title ?? snapshot.url ?? "Bilibili may start muted"}
          </p>
        </div>
        <button
          className="home-music-stop-button"
          type="button"
          onClick={stop}
          disabled={!snapshot.playing}
        >
          <Square size={16} />
          Stop
        </button>
      </div>
    </div>
  );
}
