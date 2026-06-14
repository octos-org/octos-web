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
const DEFAULT_BBC_FEED_URL = "https://feeds.bbci.co.uk/news/rss.xml";
const BBC_NEWS_READER_URL =
  "https://r.jina.ai/http://https://www.bbc.com/news";

function isDefaultBbcFeed(url: string): boolean {
  return url.trim() === DEFAULT_BBC_FEED_URL;
}

function relativePubDate(text: string): string {
  const minutes = text.match(/\b(\d+)\s+mins?\s+ago\b/i);
  if (minutes) {
    return new Date(Date.now() - Number(minutes[1]) * 60_000).toISOString();
  }
  const hours = text.match(/\b(\d+)\s+hrs?\s+ago\b/i);
  if (hours) {
    return new Date(Date.now() - Number(hours[1]) * 3_600_000).toISOString();
  }
  return "";
}

function cleanReaderTitle(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/^LIVE\s+##\s+/i, "LIVE ")
    .replace(/^##\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/\b\d+\s+(?:mins?|hrs?)\s+ago\b.*$/i, "")
    .trim();
}

function parseBbcReaderMarkdown(markdown: string): NewsItem[] {
  const seen = new Set<string>();
  const items: NewsItem[] = [];

  for (const line of markdown.split("\n")) {
    if (!line.includes("##") || !line.includes("https://www.bbc.com/")) {
      continue;
    }
    const match = line.match(/##\s*(?:\[)?(.+?)\]\((https:\/\/www\.bbc\.com\/[^)]+)\)/);
    if (!match) continue;

    const title = cleanReaderTitle(match[1]);
    const link = match[2];
    if (!title || seen.has(link)) continue;

    seen.add(link);
    items.push({
      title,
      link,
      pubDate: relativePubDate(line),
    });
    if (items.length >= MAX_ITEMS) break;
  }

  return items;
}

async function fetchDefaultBbcNews(): Promise<NewsItem[]> {
  const res = await fetch(BBC_NEWS_READER_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const markdown = await res.text();
  const items = parseBbcReaderMarkdown(markdown);
  if (items.length === 0) throw new Error("Feed error");
  return items;
}

async function fetchRss2JsonNews(url: string): Promise<NewsItem[]> {
  const endpoint = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (data.status !== "ok") throw new Error(data.message ?? "Feed error");

  return (data.items ?? [])
    .slice(0, MAX_ITEMS)
    .map((item: Record<string, unknown>) => ({
      title: String(item.title ?? ""),
      link: String(item.link ?? ""),
      pubDate: String(item.pubDate ?? ""),
      thumbnail: item.thumbnail
        ? String(item.thumbnail)
        : item.enclosure && (item.enclosure as Record<string, unknown>).link
          ? String((item.enclosure as Record<string, unknown>).link)
          : undefined,
    }));
}

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

      const items = isDefaultBbcFeed(url)
        ? await fetchDefaultBbcNews()
        : await fetchRss2JsonNews(url);

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
