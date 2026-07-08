import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

import { UiProtocolQuestionDialog } from "./ui-protocol-question-dialog";
import type { UserQuestionRequestedEvent } from "@/runtime/ui-protocol-types";

const respondToUserQuestion = vi.fn();
vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: () => ({ respondToUserQuestion }),
}));

function ev(
  over: Partial<UserQuestionRequestedEvent> = {},
): UserQuestionRequestedEvent {
  return {
    session_id: "sess-1",
    question_id: "q-1",
    turn_id: "t-1",
    title: "Pick an approach",
    body: "How should we proceed?",
    questions: [
      {
        header: "Approach",
        question: "Which approach?",
        options: [
          { label: "Merge the three", description: "Ship the clean fixes now" },
          { label: "Defer #4", description: "Leave it for later" },
        ],
        multi_select: false,
        allow_free_text: true,
      },
    ],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  respondToUserQuestion.mockReset();
});

describe("UiProtocolQuestionDialog", () => {
  it("renders options as clickable cards with descriptions", () => {
    render(
      <UiProtocolQuestionDialog
        question={ev()}
        sessionId="sess-1"
        onResolved={() => {}}
      />,
    );
    expect(screen.getByText("Which approach?")).toBeTruthy();
    expect(screen.getByText("Merge the three")).toBeTruthy();
    expect(screen.getByText("Ship the clean fixes now")).toBeTruthy();
    // Submit disabled until something is chosen.
    expect(
      (screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("single-select picks one and submits the chosen label", async () => {
    respondToUserQuestion.mockResolvedValue({
      question_id: "q-1",
      accepted: true,
      runtime_resumed: true,
    });
    const onResolved = vi.fn();
    render(
      <UiProtocolQuestionDialog
        question={ev()}
        sessionId="sess-1"
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByText("Merge the three"));
    const submit = screen.getByRole("button", {
      name: "Submit",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(respondToUserQuestion).toHaveBeenCalledTimes(1));
    expect(respondToUserQuestion).toHaveBeenCalledWith("q-1", [
      { selected_labels: ["Merge the three"] },
    ]);
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it("single-select replaces the prior pick", () => {
    render(
      <UiProtocolQuestionDialog
        question={ev()}
        sessionId="sess-1"
        onResolved={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Merge the three"));
    fireEvent.click(screen.getByText("Defer #4"));
    // Only the second is pressed.
    const merge = screen.getByText("Merge the three").closest("button")!;
    const defer = screen.getByText("Defer #4").closest("button")!;
    expect(merge.getAttribute("aria-pressed")).toBe("false");
    expect(defer.getAttribute("aria-pressed")).toBe("true");
  });

  it("free-text Other requires text before submit and sends it", async () => {
    respondToUserQuestion.mockResolvedValue({
      question_id: "q-1",
      accepted: true,
      runtime_resumed: true,
    });
    render(
      <UiProtocolQuestionDialog
        question={ev()}
        sessionId="sess-1"
        onResolved={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Other…"));
    // Still disabled — Other chosen but empty.
    expect(
      (screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Type your answer"), {
      target: { value: "a third way" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(respondToUserQuestion).toHaveBeenCalledWith("q-1", [
        { selected_labels: [], free_text: "a third way" },
      ]),
    );
  });

  it("multi-select keeps several and shows Next across questions", async () => {
    respondToUserQuestion.mockResolvedValue({
      question_id: "q-1",
      accepted: true,
      runtime_resumed: true,
    });
    const two = ev({
      questions: [
        {
          header: "Feats",
          question: "Which features?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
            { label: "C", description: "" },
          ],
          multi_select: true,
          allow_free_text: false,
        },
        {
          header: "Ship",
          question: "Ship now?",
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
          multi_select: false,
          allow_free_text: false,
        },
      ],
    });
    render(
      <UiProtocolQuestionDialog
        question={two}
        sessionId="sess-1"
        onResolved={() => {}}
      />,
    );
    // First question is multi-select → button says Next, and two picks stick.
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByText("C"));
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // Second question.
    expect(screen.getByText("Ship now?")).toBeTruthy();
    fireEvent.click(screen.getByText("Yes"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(respondToUserQuestion).toHaveBeenCalledWith("q-1", [
        { selected_labels: ["A", "C"] },
        { selected_labels: ["Yes"] },
      ]),
    );
  });
});
