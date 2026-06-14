import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useNews } from "./use-news";

const DEFAULT_FEED = "https://feeds.bbci.co.uk/news/rss.xml";

function Probe({ feedUrl = DEFAULT_FEED }: { feedUrl?: string }) {
  const news = useNews(feedUrl);
  return <output data-testid="news-state">{JSON.stringify(news)}</output>;
}

function readState() {
  return JSON.parse(screen.getByTestId("news-state").textContent || "{}");
}

describe("useNews", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the default BBC headlines without hitting the rate-limited rss2json endpoint", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        `Title: BBC News

Markdown Content:
[![Image 1](https://ichef.bbci.co.uk/news.jpg) ## Royal Marines board Russian shadow fleet oil tanker in English Channel Marines were joined by officers. 54 mins ago Europe](https://www.bbc.com/news/articles/clyek039l2vo)
## [Why the US economy keeps defying the odds](https://www.bbc.com/news/articles/cwy031el03po)
## [Swiss voters reject 10 million population cap, early projections say 7 hrs ago Europe](https://www.bbc.com/news/articles/c20ygjem17zo)
## [Watch: British forces intercept sanctioned oil tanker 9 hrs ago UK](https://www.bbc.com/news/videos/ce8k5kj64lgo)
## [This fifth item should be ignored](https://www.bbc.com/news/articles/ignore)
`,
        { status: 200, headers: { "Content-Type": "text/plain" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Probe />);

    await waitFor(() => {
      expect(readState().items).toHaveLength(4);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("r.jina.ai");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("rss2json");
    expect(readState().items[0].title).toContain("Royal Marines");
    expect(readState().error).toBeNull();
  });
});
