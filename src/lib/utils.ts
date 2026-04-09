import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
