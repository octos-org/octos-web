import { request } from "@/api/client";

export interface BilibiliMusicScene {
  id: string;
  label: string;
  keyword: string;
}

export interface BilibiliVideoResult {
  title: string;
  url: string;
}

export interface BilibiliMusicPlayResult {
  opened: boolean;
  fallback: boolean;
  title?: string;
  url: string;
}

export interface BilibiliMusicSnapshot {
  playing: boolean;
  scene?: BilibiliMusicScene;
  title?: string;
  url?: string;
  fallback: boolean;
}

export type ResolveFirstBilibiliVideo = (
  keyword: string,
) => Promise<BilibiliVideoResult | null>;

export const BILIBILI_MUSIC_SCENES: readonly BilibiliMusicScene[] = [
  { id: "morning-radio", label: "Morning radio", keyword: "Morning radio" },
  { id: "cooking-dinner", label: "Cooking / Dinner", keyword: "Cooking / Dinner" },
  { id: "focus", label: "Focus", keyword: "Focus" },
  { id: "kids", label: "Kids", keyword: "Kids" },
  { id: "sleep", label: "Sleep", keyword: "Sleep" },
  { id: "party", label: "Party", keyword: "Party" },
];

const BILIBILI_WINDOW_NAME = "octos-bilibili-music";

export function buildBilibiliSearchUrl(keyword: string): string {
  const query = `${keyword.trim()} \u97F3\u4E50`.trim();
  return `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`;
}

async function defaultResolveFirstVideo(
  keyword: string,
): Promise<BilibiliVideoResult | null> {
  const query = `${keyword.trim()} \u97F3\u4E50`.trim();
  const data = await request<Partial<BilibiliVideoResult>>(
    `/api/integrations/bilibili/first-video?keyword=${encodeURIComponent(query)}`,
  );
  if (!data.url || !data.title) return null;
  return { title: data.title, url: data.url };
}

export function createBilibiliMusicController(options?: {
  resolveFirstVideo?: ResolveFirstBilibiliVideo;
}) {
  const resolveFirstVideo = options?.resolveFirstVideo ?? defaultResolveFirstVideo;
  let musicWindow: Window | null = null;
  let snapshot: BilibiliMusicSnapshot = { playing: false, fallback: false };

  const navigateOwnedWindow = (url: string) => {
    if (!musicWindow || musicWindow.closed) {
      musicWindow = window.open(
        "about:blank",
        BILIBILI_WINDOW_NAME,
        "noopener=false,noreferrer=false",
      );
    }
    if (!musicWindow) return false;
    musicWindow.location.href = url;
    musicWindow.focus?.();
    return true;
  };

  return {
    getSnapshot: () => snapshot,

    async playScene(scene: BilibiliMusicScene): Promise<BilibiliMusicPlayResult> {
      const searchUrl = buildBilibiliSearchUrl(scene.keyword);
      let video: BilibiliVideoResult | null = null;

      // Open synchronously inside the click handler before awaiting the network.
      if (!musicWindow || musicWindow.closed) {
        musicWindow = window.open(
          "about:blank",
          BILIBILI_WINDOW_NAME,
          "noopener=false,noreferrer=false",
        );
      }

      try {
        video = await resolveFirstVideo(scene.keyword);
      } catch {
        video = null;
      }

      const targetUrl = video?.url ?? searchUrl;
      const opened = navigateOwnedWindow(targetUrl);
      const result: BilibiliMusicPlayResult = {
        opened,
        fallback: !video,
        title: video?.title,
        url: targetUrl,
      };
      snapshot = {
        playing: opened,
        scene,
        title: video?.title,
        url: targetUrl,
        fallback: !video,
      };
      return result;
    },

    stop() {
      if (musicWindow && !musicWindow.closed) {
        musicWindow.close();
      }
      musicWindow = null;
      snapshot = { playing: false, fallback: false };
    },
  };
}
