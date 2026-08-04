import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Profile } from "@/settings/settings-api";
import { ModelSetupNotice, isModelConfigured } from "./model-setup-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const apiMocks = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
}));

vi.mock("@/settings/settings-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/settings/settings-api")>()),
  getMyProfile: apiMocks.getMyProfile,
}));

function profileWithPrimary(familyId: string, modelId: string): Profile {
  return {
    id: "p1",
    name: "P1",
    enabled: true,
    data_dir: null,
    created_at: "",
    updated_at: "",
    status: { running: false, pid: null, started_at: null, uptime_secs: null },
    config: {
      llm: { primary: { family_id: familyId, model_id: modelId }, fallbacks: [] },
      channels: [],
      gateway: {
        max_history: null,
        max_iterations: null,
        system_prompt: null,
        max_concurrent_sessions: null,
        browser_timeout_secs: null,
        max_output_tokens: null,
      },
      env_vars: {},
      hooks: [],
      email: null,
      api_type: null,
      admin_mode: false,
      sandbox: { enabled: false } as Profile["config"]["sandbox"],
      adaptive_routing: null,
      content_routing: null,
      plugins: { require_signed: false },
    } as Profile["config"],
  };
}

function blankProfile(): Profile {
  const p = profileWithPrimary("", "");
  return p;
}

function mount(node: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("isModelConfigured", () => {
  it("is false when the primary selection is empty", () => {
    expect(isModelConfigured(blankProfile())).toBe(false);
    expect(isModelConfigured(profileWithPrimary("  ", ""))).toBe(false);
  });

  it("is true when family or model is set (mirrors has_llm_selection)", () => {
    expect(isModelConfigured(profileWithPrimary("anthropic", ""))).toBe(true);
    expect(isModelConfigured(profileWithPrimary("", "claude-haiku-4-5"))).toBe(true);
    // …and does not demand a stored key: host-env credentials never show
    // up in config.env_vars but still work at bootstrap time.
    expect(isModelConfigured(profileWithPrimary("anthropic", "claude-haiku-4-5"))).toBe(true);
  });
});

describe("ModelSetupNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the setup banner with a settings deep link when no model is selected", async () => {
    apiMocks.getMyProfile.mockResolvedValue(blankProfile());
    const harness = mount(<ModelSetupNotice />);
    await flush();

    const notice = harness.container.querySelector(
      '[data-testid="model-setup-notice"]',
    );
    expect(notice?.textContent).toContain("No model is set up");
    expect(
      notice
        ?.querySelector('[data-testid="model-setup-notice-link"]')
        ?.getAttribute("href"),
    ).toBe("/settings?tab=llm");
    harness.unmount();
  });

  it("stays silent when a model is configured", async () => {
    apiMocks.getMyProfile.mockResolvedValue(
      profileWithPrimary("anthropic", "claude-haiku-4-5"),
    );
    const harness = mount(<ModelSetupNotice />);
    await flush();
    expect(
      harness.container.querySelector('[data-testid="model-setup-notice"]'),
    ).toBeNull();
    harness.unmount();
  });

  it("stays silent when the profile cannot be loaded", async () => {
    apiMocks.getMyProfile.mockRejectedValue(new Error("boom"));
    const harness = mount(<ModelSetupNotice />);
    await flush();
    expect(
      harness.container.querySelector('[data-testid="model-setup-notice"]'),
    ).toBeNull();
    harness.unmount();
  });

  it("dismisses on the close button and re-checks on window focus", async () => {
    apiMocks.getMyProfile.mockResolvedValue(blankProfile());
    const harness = mount(<ModelSetupNotice />);
    await flush();
    expect(
      harness.container.querySelector('[data-testid="model-setup-notice"]'),
    ).not.toBeNull();

    act(() => {
      (
        harness.container.querySelector(
          'button[aria-label="Dismiss"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      harness.container.querySelector('[data-testid="model-setup-notice"]'),
    ).toBeNull();

    // After "configuring" elsewhere, focusing the window re-checks and (with
    // dismissal still latched for the session) keeps the banner hidden — but
    // the fetch itself must fire so a fresh mount reflects the new state.
    apiMocks.getMyProfile.mockResolvedValue(
      profileWithPrimary("anthropic", "claude-haiku-4-5"),
    );
    const callsBefore = apiMocks.getMyProfile.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(apiMocks.getMyProfile.mock.calls.length).toBeGreaterThan(callsBefore);
    harness.unmount();
  });
});
