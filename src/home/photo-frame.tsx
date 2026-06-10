/**
 * Photo frame widget — ambient image display with crossfade.
 *
 * Shows the current photo from the user's configured list.
 * Crossfades between images using two stacked img elements.
 */

import { useEffect, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import { usePhotos } from "./use-photos";

export function PhotoFrame() {
  const { currentUrl } = usePhotos();
  const [displayed, setDisplayed] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentUrl || currentUrl === displayed) return;
    setFading(true);
    const t = setTimeout(() => {
      prevRef.current = displayed;
      setDisplayed(currentUrl);
      setFading(false);
    }, 600);
    return () => clearTimeout(t);
  }, [currentUrl, displayed]);

  if (!currentUrl && !displayed) {
    return (
      <div className="home-widget home-photo-frame mt-4 mx-4 px-5 py-6 flex flex-col items-center gap-2">
        <ImageIcon size={24} className="text-white/20" />
        <span className="text-sm text-white/25">Add photos in Settings</span>
      </div>
    );
  }

  return (
    <div className="home-photo-frame-container mt-4 mx-4">
      {prevRef.current && fading && (
        <img
          src={prevRef.current}
          alt=""
          className="home-photo-frame-img home-photo-frame-out"
        />
      )}
      {displayed && (
        <img
          src={displayed}
          alt=""
          className={`home-photo-frame-img ${fading ? "home-photo-frame-in" : ""}`}
        />
      )}
    </div>
  );
}
