import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  FlashcardsViewer,
  QuizViewer,
  ReportViewer,
} from "./study-asset-viewers";
import { parseFlashcardsMarkdown, parseQuizMarkdown } from "./study-asset-parsers";

afterEach(cleanup);

const QUIZ = `# Climate quiz

1. Which gas is most abundant?
   - Oxygen
   - Nitrogen
   Answer: Nitrogen
   Explanation: It makes up most of the atmosphere. [Source (source.md:L1-L2)]

2. What warms the planet?
   Answer: Greenhouse gases
   Explanation: They retain heat. [Source (source.md:L3-L4)]
`;

const CARDS = `# Climate cards

- Front: Most abundant atmospheric gas?
  Back: Nitrogen [Source (source.md:L1-L2)]
- Front: Main greenhouse gas from fossil fuels?
  Back: Carbon dioxide [Source (source.md:L3-L4)]
`;

describe("study asset parsers", () => {
  it("parses the current notebook quiz Markdown contract", () => {
    expect(parseQuizMarkdown(QUIZ)).toMatchObject({
      title: "Climate quiz",
      questions: [
        { question: "Which gas is most abundant?", choices: ["Oxygen", "Nitrogen"], answer: "Nitrogen" },
        { question: "What warms the planet?", answer: "Greenhouse gases" },
      ],
    });
  });

  it("parses the current notebook flashcard Markdown contract", () => {
    expect(parseFlashcardsMarkdown(CARDS)).toMatchObject({
      title: "Climate cards",
      cards: [
        { front: "Most abundant atmospheric gas?", back: expect.stringContaining("Nitrogen") },
        { front: "Main greenhouse gas from fossil fuels?", back: expect.stringContaining("Carbon dioxide") },
      ],
    });
  });
});

describe("study asset viewers", () => {
  it("keeps quiz answers hidden and supports question navigation", () => {
    render(<QuizViewer text={QUIZ} />);

    expect(screen.getByText("Which gas is most abundant?")).toBeTruthy();
    expect(screen.queryByText("Answer: Nitrogen")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show answer" }));
    expect(screen.getByText("Answer: Nitrogen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.getByText("What warms the planet?")).toBeTruthy();
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });

  it("flips cards, records progress, and navigates", () => {
    render(<FlashcardsViewer text={CARDS} />);

    expect(screen.getByText("Most abundant atmospheric gas?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Flip card" }));
    expect(screen.getByText(/Nitrogen/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.getByLabelText("1 got it · 0 missed")).toBeTruthy();
    expect(screen.getByText("Main greenhouse gas from fossil fuels?")).toBeTruthy();
  });

  it("builds a report table of contents from headings", () => {
    render(<ReportViewer text={"# Report\n\n## Findings\nBody\n\n## Risks\nMore"} />);
    expect(screen.getByRole("navigation", { name: "Report contents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Findings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Risks" })).toBeTruthy();
  });
});
