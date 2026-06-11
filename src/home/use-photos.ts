/**
 * Photo frame hook — cycles through user-provided image URLs.
 *
 * URLs are stored in localStorage (`octos_home_photos`).
 * Cycles every 30 seconds with a new index.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

const LS_KEY = "octos_home_photos";
const CYCLE_MS = 30_000;

let listeners: Array<() => void> = [];

function emit() {
  for (const fn of listeners) fn();
}

function readPhotos(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string" && u.trim() !== "") : [];
  } catch {
    return [];
  }
}

function writePhotos(urls: string[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(urls));
  emit();
}

// Cache the snapshot by raw localStorage string so the returned reference is
// stable across renders when the data hasn't changed. Passing `readPhotos`
// (a fresh array every call) straight to `useSyncExternalStore` returned a new
// reference each render → "getSnapshot should be cached" → infinite re-render
// loop (Maximum update depth) → /home crash. Recompute only on real change.
let snapshotRaw: string | null | undefined;
let snapshotValue: string[] = [];

function getPhotosSnapshot(): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_KEY);
  } catch {
    raw = null;
  }
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshotValue = readPhotos();
  }
  return snapshotValue;
}

function subscribe(cb: () => void) {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((fn) => fn !== cb);
  };
}

export function usePhotos() {
  const photos = useSyncExternalStore(
    subscribe,
    getPhotosSnapshot,
    getPhotosSnapshot,
  );
  const [index, setIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (photos.length <= 1) return;
    timerRef.current = setInterval(() => {
      setIndex((prev) => (prev + 1) % photos.length);
    }, CYCLE_MS);
    return () => clearInterval(timerRef.current);
  }, [photos.length]);

  useEffect(() => {
    if (index >= photos.length && photos.length > 0) {
      setIndex(0);
    }
  }, [photos.length, index]);

  const addPhoto = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const current = readPhotos();
    if (!current.includes(trimmed)) {
      writePhotos([...current, trimmed]);
    }
  }, []);

  const removePhoto = useCallback((url: string) => {
    writePhotos(readPhotos().filter((u) => u !== url));
  }, []);

  return {
    photos,
    currentUrl: photos.length > 0 ? photos[index % photos.length] : null,
    addPhoto,
    removePhoto,
  };
}
