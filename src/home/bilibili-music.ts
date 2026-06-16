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
  playing: boolean;
  fallback: boolean;
  title?: string;
  url: string;
  embedUrl: string;
}

export interface BilibiliMusicSnapshot {
  playing: boolean;
  scene?: BilibiliMusicScene;
  title?: string;
  url?: string;
  embedUrl?: string;
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

const BILIBILI_AUDIO_SELECTOR = "iframe[data-octos-bilibili-audio]";
const DEFAULT_BILIBILI_MUSIC_VIDEO: BilibiliVideoResult = {
  title: "Bilibili music",
  url: "https://www.bilibili.com/video/BV1cTcbzNE9p/",
};

export function buildBilibiliSearchUrl(keyword: string): string {
  const query = `${keyword.trim()} \u97F3\u4E50`.trim();
  return `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`;
}

function extractBilibiliBvid(url: string): string | null {
  const direct = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (direct?.[1]) return direct[1];
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("bvid");
  } catch {
    return null;
  }
}

export function buildBilibiliPlayerUrl(url: string): string {
  const bvid = extractBilibiliBvid(url) ?? extractBilibiliBvid(DEFAULT_BILIBILI_MUSIC_VIDEO.url);
  return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(
    bvid ?? "BV1cTcbzNE9p",
  )}&autoplay=1&danmaku=0&high_quality=1`;
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
  let snapshot: BilibiliMusicSnapshot = { playing: false, fallback: false };

  const ensureAudioFrame = (embedUrl: string) => {
    const existing = document.querySelector<HTMLIFrameElement>(BILIBILI_AUDIO_SELECTOR);
    const frame = existing ?? document.createElement("iframe");
    frame.title = "Bilibili music audio";
    frame.setAttribute("data-octos-bilibili-audio", "true");
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.referrerPolicy = "no-referrer-when-downgrade";
    frame.src = embedUrl;
    Object.assign(frame.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      right: "0",
      bottom: "0",
      opacity: "0.001",
      pointerEvents: "none",
      border: "0",
      zIndex: "-1",
    });
    if (!existing) document.body.appendChild(frame);
  };

  const activateVideo = (
    scene: BilibiliMusicScene,
    video: BilibiliVideoResult,
    fallback: boolean,
  ): BilibiliMusicPlayResult => {
    const embedUrl = buildBilibiliPlayerUrl(video.url);
    ensureAudioFrame(embedUrl);
    const result: BilibiliMusicPlayResult = {
      playing: true,
      fallback,
      title: video.title,
      url: video.url,
      embedUrl,
    };
    snapshot = {
      playing: true,
      scene,
      title: video.title,
      url: video.url,
      embedUrl,
      fallback,
    };
    return result;
  };

  return {
    getSnapshot: () => snapshot,

    async playScene(scene: BilibiliMusicScene): Promise<BilibiliMusicPlayResult> {
      let video: BilibiliVideoResult | null = null;
      let result = activateVideo(scene, DEFAULT_BILIBILI_MUSIC_VIDEO, true);

      try {
        video = await resolveFirstVideo(scene.keyword);
      } catch {
        video = null;
      }

      if (video) result = activateVideo(scene, video, false);
      return result;
    },

    stop() {
      document.querySelectorAll(BILIBILI_AUDIO_SELECTOR).forEach((node) => {
        node.remove();
      });
      snapshot = { playing: false, fallback: false };
    },
  };
}
