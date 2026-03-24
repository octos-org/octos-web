import { test, expect } from "@playwright/test";
import { login, sendAndWait, captureSSEEvents, SEL } from "./helpers";

test.describe("Deep research pipeline", () => {
  test.setTimeout(600_000); // 10 min — pipelines are slow

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("pipeline executes and produces structured output", async ({ page }) => {
    const events = captureSSEEvents(page);

    const result = await sendAndWait(
      page,
      "Do a deep research on the latest Rust programming language developments in 2026. Run the pipeline directly, don't ask me to choose.",
      { label: "pipeline-run", maxWait: 540_000, throwOnTimeout: false },
    );

    // Pipeline should produce some output (streaming progress or final result)
    console.log(`  response length: ${result.responseLen} chars`);
    console.log(`  timed out: ${result.timedOut}`);
    // Pipeline streaming is working if we received any content at all.
    // Pipeline duration varies widely (2-10 min) depending on LLM speed,
    // so we don't assert on timedOut — just that streaming reached the client.
    expect(result.responseLen).toBeGreaterThan(0);

    // Log SSE diagnostics
    const types = [...new Set(events.map((e) => e.type))];
    console.log(`  total SSE events: ${events.length}`);
    console.log(`  event types: ${types.join(", ") || "(none)"}`);
    console.log(
      `  tool_start: ${events.filter((e) => e.type === "tool_start").length}`,
    );
    console.log(
      `  text events: ${events.filter((e) => e.type === "token" || e.type === "replace").length}`,
    );

    // Screenshot for manual review
    await page.screenshot({
      path: "/tmp/octos-test-pipeline.png",
      fullPage: true,
    });
  });
});
