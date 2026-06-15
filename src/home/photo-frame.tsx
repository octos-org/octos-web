/**
 * Photo frame widget — ambient image display with crossfade.
 *
 * Shows the current photo from the user's configured list.
 * Crossfades between images using two stacked img elements.
 */

import { useEffect, useRef, useState } from "react";
import { usePhotos } from "./use-photos";

const PLACEHOLDER_CYCLE_MS = 30_000;

const LANDSCAPE_PLACEHOLDERS = [
  {
    src: "https://picsum.photos/id/1018/960/540",
    label: "Mountain landscape",
  },
  {
    src: "https://picsum.photos/id/1015/960/540",
    label: "River valley landscape",
  },
  {
    src: "https://picsum.photos/id/10/960/540",
    label: "Forest landscape",
  },
];

export function PhotoFrame() {
  const { currentUrl } = usePhotos();
  const [displayed, setDisplayed] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentUrl) return;
    const timer = window.setInterval(() => {
      setPlaceholderIndex((index) => (index + 1) % LANDSCAPE_PLACEHOLDERS.length);
    }, PLACEHOLDER_CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [currentUrl]);

  useEffect(() => {
    if (currentUrl) return;
    prevRef.current = null;
    setDisplayed(null);
    setFading(false);
  }, [currentUrl]);

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
    const placeholder =
      LANDSCAPE_PLACEHOLDERS[placeholderIndex % LANDSCAPE_PLACEHOLDERS.length];
    return (
      <div className="home-photo-frame-container mt-4 mx-4">
        <img
          src={placeholder.src}
          alt={placeholder.label}
          className="home-photo-frame-img"
          loading="lazy"
        />
        <div className="home-photo-placeholder-caption">
          <span>{placeholder.label}</span>
          <span>Add photos in Settings</span>
        </div>
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
