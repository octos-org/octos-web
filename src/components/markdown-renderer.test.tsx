import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./markdown-renderer";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn() } }));
afterEach(cleanup);

describe("source links in Markdown", () => {
  it("keeps Chinese closing punctuation outside an automatically linked source URL", () => {
    const text = "来源于中国天气网（https://www.weather.com.cn/weather/101020100.shtml）。";
    const { container } = render(<MarkdownContent text={text} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://www.weather.com.cn/weather/101020100.shtml");
    expect(link.textContent).toBe("https://www.weather.com.cn/weather/101020100.shtml");
    expect(container.textContent).toBe(text);
  });

  it.each(["，", "。", "；", "！", "？", "】", "》", "”"])("preserves trailing %s as prose", (punctuation) => {
    const text = `来源 https://example.com/weather?city=北京${punctuation}`;
    const { container } = render(<MarkdownContent text={text} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.com/weather?city=%E5%8C%97%E4%BA%AC");
    expect(container.textContent).toBe(text);
  });

  it.each([
    ["[source](https://example.com/）。)", "https://example.com/%EF%BC%89%E3%80%82"],
    ["<https://example.com/）。>", "https://example.com/%EF%BC%89%E3%80%82"],
    ["https://example.com/%EF%BC%89%E3%80%82", "https://example.com/%EF%BC%89%E3%80%82"],
    ["https://example.com/wiki/Weather_(forecast)", "https://example.com/wiki/Weather_(forecast)"],
  ])("preserves an intentional URL: %s", (text, href) => {
    render(<MarkdownContent text={text} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(href);
  });

  it("does not link or rewrite a URL in inline code", () => {
    render(<MarkdownContent text="`https://example.com/）。`" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("https://example.com/）。").tagName).toBe("CODE");
  });
});
