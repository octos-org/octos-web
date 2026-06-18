/**
 * Multi-round slides iteration smoke through the current chat UI protocol.
 */

import { expect, test, type Page } from "@playwright/test";
import { createNewSession, login, sendAndWait } from "./helpers";

test.setTimeout(180_000);

test.beforeEach(async ({ page }) => {
  await login(page);
  await createNewSession(page);
});

async function chat(page: Page, message: string): Promise<string> {
  const result = await sendAndWait(page, message, {
    label: "slides-stress",
    maxWait: 45_000,
    throwOnTimeout: false,
  });
  return result.responseText;
}

test("5-round slides iteration stress test", async ({ page }) => {
  const results: { round: string; pass: boolean; reason: string }[] = [];

  const setup = await chat(page, "/new slides stress-deck");
  results.push({
    round: "Setup",
    pass: /slides|project|switched|created/i.test(setup),
    reason: setup.slice(0, 120),
  });

  const r1 = await chat(
    page,
    `Create a 5-slide deck about "The Future of Space Exploration".
Style: nb-pro.
Slides:
1) Cover: "Space 2030" with subtitle "Humanity's Next Giant Leap"
2) Mars colonization timeline
3) Private vs government space programs comparison
4) Space economy projections ($1T by 2040)
5) Closing: "Ad Astra" call to action

Write script.js with full prompts and texts. Do NOT generate yet. Show me the slide plan.`,
  );
  results.push({
    round: "R1: Create 5 slides",
    pass: /script\.js|slide|write/i.test(r1) && !/generated deck\.pptx/i.test(r1),
    reason: r1.slice(0, 120),
  });

  const r2 = await chat(
    page,
    `Update two slides:
- Slide 2: Change title to "Mars by 2028: The Accelerated Timeline" and add a bullet about SpaceX Starship
- Slide 4: Change the projection from $1T to $3T and add "including space mining"

Only modify slides 2 and 4 in script.js. Do NOT touch slides 1, 3, 5. Do NOT generate.`,
  );
  results.push({
    round: "R2: Modify slides 2+4",
    pass: /script\.js|slide|write/i.test(r2) && !/generated deck\.pptx/i.test(r2),
    reason: r2.slice(0, 120),
  });

  const r3 = await chat(page, "Generate the PPTX now.");
  results.push({
    round: "R3: Generate PPTX",
    pass: /generated|pptx|artifact/i.test(r3),
    reason: r3.slice(0, 120),
  });

  const r4 = await chat(
    page,
    `Update slide 3 only: Change the comparison to include Blue Origin and add a row for Rocket Lab.
Follow the incremental update workflow:
1. Read script.js
2. Modify ONLY slide 3
3. Delete slide-03.png from the slide dir
4. Regenerate

Do NOT modify any other slides.`,
  );
  results.push({
    round: "R4: Incremental update slide 3",
    pass: /slide|script|generated|pptx|artifact/i.test(r4),
    reason: r4.slice(0, 120),
  });

  const r5 = await chat(
    page,
    `Add a new slide 6: "International Cooperation: ISS Legacy and Lunar Gateway"
Keep slides 1-5 completely unchanged. Just append the new slide to script.js.
Then regenerate — only the new slide 6 should be generated, slides 1-5 should use cached PNGs.`,
  );
  results.push({
    round: "R5: Add slide 6, keep 1-5 cached",
    pass: /slide|script|generated|pptx|artifact/i.test(r5),
    reason: r5.slice(0, 120),
  });

  for (const result of results) {
    console.log(`${result.pass ? "pass" : "fail"} ${result.round}: ${result.reason}`);
  }

  expect(results.filter((result) => result.pass)).toHaveLength(results.length);
});
