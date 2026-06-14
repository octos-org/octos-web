/**
 * Photo frame hook — cycles through profile-backed user image URLs.
 */

import { useEffect, useState } from "react";
import { useHomeSettings } from "./home-settings-context";

const CYCLE_MS = 30_000;

export function usePhotos() {
  const { photos, addPhoto, removePhoto } = useHomeSettings();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (photos.length <= 1) return;
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % photos.length);
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, [photos.length]);

  useEffect(() => {
    if (index >= photos.length && photos.length > 0) {
      setIndex(0);
    }
  }, [photos.length, index]);

  return {
    photos,
    currentUrl: photos.length > 0 ? photos[index % photos.length] : null,
    addPhoto,
    removePhoto,
  };
}
