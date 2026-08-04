import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QUADRATIC_DEMO_PACKET } from "./quadratic-demo";
import { InfiniteBoard } from "./infinite-board";

describe("InfiniteBoard", () => {
  afterEach(cleanup);

  it("renders the lesson as board objects instead of chat bubbles", () => {
    const { container } = render(
      <InfiniteBoard
        packet={QUADRATIC_DEMO_PACKET}
        segmentIndex={QUADRATIC_DEMO_PACKET.segments.length - 1}
      />,
    );

    expect(
      screen.getAllByText("二次函数的顶点与图像").length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: "二次函数坐标图" })).toBeTruthy();
    expect(screen.getByText(/y = x² \+ 6x \+ 5/)).toBeTruthy();
    expect(container.querySelector(".voice-transcript-turn")).toBeNull();
  });

  it("supports explicit zoom controls", () => {
    const { container, getByRole } = render(
      <InfiniteBoard packet={QUADRATIC_DEMO_PACKET} segmentIndex={0} />,
    );
    expect(
      container.querySelector(".learning-board")?.getAttribute("data-zoom"),
    ).toBe("0.90");

    fireEvent.click(getByRole("button", { name: "知识全景" }));
    expect(
      container.querySelector(".learning-board")?.getAttribute("data-zoom"),
    ).toBe("0.38");
  });
});
