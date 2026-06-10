/**
 * useNews — fetches RSS feed headlines via rss2json.com proxy (handles CORS).
 *
 * Polls every 30 minutes.  Returns top 4 items with title, link, pubDate,
 * and optional thumbnail.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  thumbnail?: string;
}

export interface NewsState {
  items: NewsItem[];
  loading: boolean;
  error: string | null;
}

const POLL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ITEMS = 4;

export function useNews(feedUrl: string): NewsState {
  const [state, setState] = useState<NewsState>({
    items: [],
    loading: true,
    error: null,
  });

  // Keep a ref so the interval closure always sees the latest URL.
  const urlRef = useRef(feedUrl);
  urlRef.current = feedUrl;

  const fetchNews = useCallback(async () => {
    const url = urlRef.current;
    if (!url) {
      setState({ items: [], loading: false, error: null });
      return;
    }

    try {
      setState((prev) => ({ ...prev, loading: prev.items.length === 0 }));

      const endpoint = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (data.status !== "ok") throw new Error(data.message ?? "Feed error");

      const items: NewsItem[] = (data.items ?? [])
        .slice(0, MAX_ITEMS)
        .map((item: Record<string, unknown>) => ({
          title: String(item.title ?? ""),
          link: String(item.link ?? ""),
          pubDate: String(item.pubDate ?? ""),
          thumbnail: item.thumbnail ? String(item.thumbnail) : item.enclosure && (item.enclosure as Record<string, unknown>).link ? String((item.enclosure as Record<string, unknown>).link) : undefined,
        }));

      setState({ items, loading: false, error: null });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, []);

  useEffect(() => {
    fetchNews();
    const id = setInterval(fetchNews, POLL_MS);
    return () => clearInterval(id);
  }, [fetchNews, feedUrl]);

  return state;
}

/** Human-friendly relative time. */
export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff) || diff < 0) return "";
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
