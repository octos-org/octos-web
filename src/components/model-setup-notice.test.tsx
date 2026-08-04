import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Profile } from "@/settings/settings-api";
import {
  ModelSetupNotice,
  isModelConfigured,
  modelSetupState,
} from "./model-setup-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const apiMocks = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
}));

vi.mock("@/settings/settings-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/settings/settings-api")>()),
  getMyProfile: apiMocks.getMyProfile,
}));

function makeProfile(
  familyId: string,
  modelId: string,
  envVars: Record<string, string> = {},
): Profile {
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
      env_vars: envVars,
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

const READY_PROFILE = makeProfile("anthropic", "claude-haiku-4-5", {
  // Masked value, as the backend serves it — presence is what matters.
  ANTHROPIC_API_KEY: "***",
});
const NO_SELECTION_PROFILE = makeProfile("", "");
const KEY_MISSING_PROFILE = makeProfile("anthropic", "claude-haiku-4-5");

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

describe("modelSetupState", () => {
  it("is no-selection when the primary selection is empty", () => {
    expect(modelSetupState(NO_SELECTION_PROFILE)).toBe("no-selection");
    expect(modelSetupState(makeProfile("  ", ""))).toBe("no-selection");
  });

  it("is key-missing when a keyed provider has no stored credential", () => {
    expect(modelSetupState(KEY_MISSING_PROFILE)).toBe("key-missing");
    // Selection by model alone still requires the family's key.
    expect(modelSetupState(makeProfile("anthropic", ""))).toBe("key-missing");
  });

  it("is ready when the credential is stored (masked values count)", () => {
    expect(modelSetupState(READY_PROFILE)).toBe("ready");
  });

  it("is ready for keyless providers and honours a custom api_key_env route", () => {
    expect(modelSetupState(makeProfile("ollama", "llama3"))).toBe("ready");
    expect(
      modelSetupState({
        ...makeProfile("__custom_family__", "my-model"),
      }),
    ).toBe("ready");
    const routed = makeProfile("anthropic", "claude-haiku-4-5", {
      MY_OWN_KEY_VAR: "****...abc",
    });
    routed.config.llm.primary.route = { api_key_env: "MY_OWN_KEY_VAR" };
    expect(modelSetupState(routed)).toBe("ready");
  });

  it("isModelConfigured is the boolean ready view", () => {
    expect(isModelConfigured(READY_PROFILE)).toBe(true);
    expect(isModelConfigured(KEY_MISSING_PROFILE)).toBe(false);
    expect(isModelConfigured(NO_SELECTION_PROFILE)).toBe(false);
  });
});

describe("ModelSetupNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the setup banner with an LLM-tab link when no model is selected", async () => {
    apiMocks.getMyProfile.mockResolvedValue(NO_SELECTION_PROFILE);
    const harness = mount(<ModelSetupNotice />);
    await flush();

    const notice = harness.container.querySelector(
      '[data-testid="model-setup-notice"]',
    );
    expect(notice?.getAttribute("data-setup-state")).toBe("no-selection");
    expect(notice?.textContent).toContain("No model is set up");
    expect(
      notice
        ?.querySelector('[data-testid="model-setup-notice-link"]')
        ?.getAttribute("href"),
    ).toBe("/settings?tab=llm");
    harness.unmount();
  });

  it("points at the API Keys tab when the selection exists but the key does not", async () => {
    apiMocks.getMyProfile.mockResolvedValue(KEY_MISSING_PROFILE);
    const harness = mount(<ModelSetupNotice />);
    await flush();

    const notice = harness.container.querySelector(
      '[data-testid="model-setup-notice"]',
    );
    expect(notice?.getAttribute("data-setup-state")).toBe("key-missing");
    expect(notice?.textContent).toContain("needs an API key");
    expect(
      notice
        ?.querySelector('[data-testid="model-setup-notice-link"]')
        ?.getAttribute("href"),
    ).toBe("/settings?tab=api-keys");
    harness.unmount();
  });

  it("stays silent when a model is configured", async () => {
    apiMocks.getMyProfile.mockResolvedValue(READY_PROFILE);
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
    apiMocks.getMyProfile.mockResolvedValue(NO_SELECTION_PROFILE);
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

    // Focusing the window re-checks so a fresh state is picked up even
    // though the dismissal stays latched for the session.
    apiMocks.getMyProfile.mockResolvedValue(READY_PROFILE);
    const callsBefore = apiMocks.getMyProfile.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(apiMocks.getMyProfile.mock.calls.length).toBeGreaterThan(callsBefore);
    harness.unmount();
  });
});
