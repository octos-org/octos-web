import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { VoiceOrb } from "./voice-orb";

describe("VoiceOrb", () => {
  it("applies a state-specific class", () => {
    const { container } = render(<VoiceOrb state="listening" />);
    expect(container.querySelector(".voice-orb.is-listening")).not.toBeNull();
  });
  it("reflects speaking state", () => {
    const { container } = render(<VoiceOrb state="speaking" />);
    expect(container.querySelector(".voice-orb.is-speaking")).not.toBeNull();
  });
});
