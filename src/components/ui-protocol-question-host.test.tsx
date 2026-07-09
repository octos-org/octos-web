import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";

import { UiProtocolQuestionHost } from "./ui-protocol-question-host";
import type { UserQuestionRequestedEvent } from "@/runtime/ui-protocol-types";

vi.mock("@/runtime/session-context", () => ({
  useSession: () => ({ currentSessionId: "sess-1", historyTopic: undefined }),
}));
const respondToUserQuestion = vi.fn().mockResolvedValue({
  question_id: "x",
  accepted: true,
  runtime_resumed: true,
});
vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: () => ({ respondToUserQuestion }),
}));

function fire(id: string, question: string) {
  const detail: UserQuestionRequestedEvent = {
    session_id: "sess-1",
    question_id: id,
    turn_id: "t",
    title: question,
    body: "",
    questions: [
      {
        header: "H",
        question,
        options: [
          { label: "Yes", description: "" },
          { label: "No", description: "" },
        ],
        multi_select: false,
        allow_free_text: false,
      },
    ],
  };
  act(() => {
    window.dispatchEvent(
      new CustomEvent("crew:user_question_requested", { detail }),
    );
  });
}

afterEach(() => {
  cleanup();
  respondToUserQuestion.mockClear();
});

describe("UiProtocolQuestionHost", () => {
  it("queues overlapping questions and pops to the next after resolve", async () => {
    render(<UiProtocolQuestionHost />);
    // Nothing shown until a question arrives.
    expect(screen.queryByRole("dialog")).toBeNull();

    fire("q-1", "First question?");
    fire("q-2", "Second question?");
    // Only the head renders.
    expect(screen.getByText("First question?")).toBeTruthy();
    expect(screen.queryByText("Second question?")).toBeNull();

    // Answer the first → the second pops into view (not dropped).
    fireEvent.click(screen.getByText("Yes"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(respondToUserQuestion).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText("Second question?")).toBeTruthy(),
    );

    // Answer the second → dialog closes.
    fireEvent.click(screen.getByText("No"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(respondToUserQuestion).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("ignores a duplicate question_id (reconnect replay)", () => {
    render(<UiProtocolQuestionHost />);
    fire("q-1", "Only once?");
    fire("q-1", "Only once?");
    // Still exactly one dialog.
    expect(screen.getAllByText("Only once?")).toHaveLength(1);
  });
});
