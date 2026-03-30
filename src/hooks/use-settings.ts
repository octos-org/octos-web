import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "octos-settings";

export interface OctosSettings {
  searchEngine: "default" | "serper" | "duckduckgo";
  serperApiKey: string;
  crawl4aiUrl: string;
}

const defaults: OctosSettings = {
  searchEngine: "default",
  serperApiKey: "",
  crawl4aiUrl: "",
};

function load(): OctosSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...defaults };
}

function save(settings: OctosSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function useSettings() {
  const [settings, setSettingsState] = useState<OctosSettings>(load);

  useEffect(() => {
    save(settings);
  }, [settings]);

  const update = useCallback((patch: Partial<OctosSettings>) => {
    setSettingsState((prev) => ({ ...prev, ...patch }));
  }, []);

  return { settings, update };
}

/** Read settings without a hook (for non-React code like adapters). */
export function getSettings(): OctosSettings {
  return load();
}
