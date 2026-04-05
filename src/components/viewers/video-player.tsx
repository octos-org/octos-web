import { useEffect } from "react";
import { X } from "lucide-react";
import type { ContentEntry } from "@/api/content";
import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";

interface VideoPlayerProps {
  entry: ContentEntry;
  onClose: () => void;
}

export function VideoPlayer({ entry, onClose }: VideoPlayerProps) {
  const token = getToken();
  const url = `${API_BASE}/api/files?path=${encodeURIComponent(entry.path)}${
    token ? `&_token=${token}` : ""
  }`;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute -right-2 -top-10 rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>
        <video
          src={url}
          controls
          playsInline
          className="max-h-[85vh] max-w-[90vw] rounded-lg"
        >
          Your browser does not support the video tag.
        </video>
        <p className="mt-2 text-center text-sm text-white/50">
          {entry.filename}
        </p>
      </div>
    </div>
  );
}
