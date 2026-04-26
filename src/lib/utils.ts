import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Join Vite's `import.meta.env.BASE_URL` with an absolute app path.
 *
 * The coding-blue side-by-side deploy can mount the web client under
 * `/next/`. Any hard-coded `window.location.href = "/login"` bypasses
 * React Router's `basename` and sends the browser back to the legacy
 * `/` bundle, which is at best wrong and at worst logs the user out of
 * the wrong tree. Use this helper for every raw `window.location`
 * navigation to a framework-owned path (`/login`, `/chat`, `/admin/my`).
 *
 * The returned string is always absolute ("/path") so it can be assigned
 * to `window.location.href` directly.
 */
export function absoluteUrl(path: string): string {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  if (!path.startsWith("/")) return `${base}/${path}`;
  return `${base}${path}`;
}

export function displayFilename(name: string) {
  const underscore = name.indexOf("_");
  if (underscore <= 0) return name;
  const prefix = name.slice(0, underscore);
  const rest = name.slice(underscore + 1);
  if (!rest) return name;
  const uuidV7Like =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidV7Like.test(prefix) ? rest : name;
}

export function displayFilenameFromPath(path: string) {
  const base = path.split("/").pop() || "file";
  return displayFilename(base);
}
