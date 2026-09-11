import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessage, ThreadToolCall } from "@/store/thread-store";
import { groupWebResearchMessages, WebResearchActivity } from "./web-research-activity";

const call = (id: string, name = "web_search", status: ThreadToolCall["status"] = "complete"): ThreadToolCall => ({
  id, name, status, args: name === "web_search" ? { query: "Saratoga heat advisory" }
    : { url: "https://weather.gov/mtr?token=private-value#fragment" }, progress: [], retryCount: 0,
});
const message = (id: string, tools: ThreadToolCall[], text = ""): ThreadMessage => ({
  id, role: "assistant", text, files: [], toolCalls: tools, status: "complete", timestamp: 100,
});
afterEach(cleanup);

describe("Web research activity", () => {
  it("collapses eight repeated calls into one summary with accessible details", () => {
    const tools = Array.from({ length: 8 }, (_, i) => call(`tool-${i}`, i < 4 ? "web_search" : "web_fetch"));
    render(<WebResearchActivity toolCalls={tools} threadId="turn-1" />);
    expect(screen.getByText("4 searches · 4 pages")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    const toggle = screen.getByRole("button", { name: /Web research complete/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("tool-call-bubble")).toHaveLength(8);
    expect(screen.getAllByText("weather.gov/mtr")).toHaveLength(4);
    expect(document.body.textContent).not.toContain("web_fetch");
    expect(document.body.innerHTML).not.toContain("private-value");
    fireEvent.click(toggle);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("keeps a user's expansion while progress changes and exposes individual failure details", () => {
    const active = call("live", "web_fetch", "running");
    const view = render(<WebResearchActivity toolCalls={[active]} threadId="turn-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Reading webpages/ }));
    const failed = { ...active, status: "error" as const, progress: [{ message: "HTTP 429: try again later", ts: 200 }] };
    view.rerender(<WebResearchActivity toolCalls={[failed]} threadId="turn-1" />);
    expect(screen.getByRole("button", { name: /Web research needs attention/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("1 failed")).toBeTruthy();
    expect(screen.getByText("HTTP 429: try again later")).toBeTruthy();
    expect(screen.queryByLabelText("Running")).toBeNull();
  });

  it("does not hide a failed call behind another running call", () => {
    render(<WebResearchActivity toolCalls={[call("failed", "web_fetch", "error"), call("live", "web_search", "running")]} threadId="turn-1" />);
    expect(screen.getByText("Searching the web")).toBeTruthy();
    expect(screen.getByText("1 failed")).toBeTruthy();
    expect(screen.getByText("Saratoga heat advisory")).toBeTruthy();
  });

  it("keeps progress and retry information available without JSON noise", () => {
    const tool = { ...call("retry"), retryCount: 2, args: JSON.stringify({ query: "Beijing weather" }),
      progress: [{ message: "First attempt failed", ts: 10 }, { message: "Found current observations", ts: 20 }] };
    render(<WebResearchActivity toolCalls={[tool]} threadId="turn-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Web research complete/ }));
    expect(screen.getByText("Retried 2 times")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Search Beijing weather/ }));
    expect(screen.getByText("First attempt failed")).toBeTruthy();
    expect(screen.getByText("Found current observations")).toBeTruthy();
    expect(screen.getByTestId("tool-call-bubble").getAttribute("data-tool-call-id")).toBe("retry");
  });

  it("reads canonical argument previews while hiding URL credentials and ignoring truncated values", () => {
    const tools = [
      { ...call("search"), args: 'count: 5, query: "Python asyncio documentation"' },
      { ...call("fetch", "web_fetch"), args: 'max_chars: 12000, url: "https://user:private-password@docs.python.org/3/library/asyncio.html?token=private-token#fragment"' },
      { ...call("truncated", "web_fetch"), args: 'url: "https://docs.python.org/3/library/…' },
      { ...call("quoted", "web_fetch"), args: 'query: "a comma, url: \\"https://wrong.example/\\""' },
    ];
    render(<WebResearchActivity toolCalls={tools} threadId="turn-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Web research complete/ }));
    expect(screen.getByText("Python asyncio documentation")).toBeTruthy();
    expect(screen.getByText("docs.python.org/3/library/asyncio.html")).toBeTruthy();
    expect(screen.getAllByText("Webpage")).toHaveLength(2);
    expect(document.body.innerHTML).not.toMatch(/private-password|private-token|wrong\.example/);
  });
});

describe("research message grouping", () => {
  it("groups adjacent tool-only iterations and the pending tail without mutating source messages", () => {
    const first = message("first", [call("search")]);
    const last = { ...message("pending", [call("fetch", "web_fetch", "running")]), status: "streaming" as const };
    const rows = groupWebResearchMessages([first, last]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("first");
    expect(rows[0].toolCalls.map(t => t.id)).toEqual(["search", "fetch"]);
    expect(rows[0].status).toBe("streaming");
    expect(first.toolCalls).toHaveLength(1);
  });

  it("never crosses narration, attachment, or other-tool boundaries", () => {
    const before = message("before", [call("a")]);
    const after = message("after", [call("b")]);
    const boundaries = [message("narration", [], "Here is what I found."),
      { ...message("file", []), files: [{ path: "pf/report", filename: "report.pdf" }] },
      message("shell", [call("shell", "shell")])];
    for (const boundary of boundaries) expect(groupWebResearchMessages([before, boundary, after])).toEqual([before, boundary, after]);
  });
});
