import { describe, expect, it } from "vitest";
import {
  cronToggleRefusalReason,
  mergeProfileConfig,
  normalizeProfileConfig,
} from "./settings-api";
import { BridgeRpcError } from "@/runtime/ui-protocol-bridge";

describe("mergeProfileConfig — voice TTS fields", () => {
  it("should carry tts_provider and tts_cloud through a patch", () => {
    const current = normalizeProfileConfig({});
    const next = mergeProfileConfig(current, {
      tts_provider: "cloud",
      tts_cloud: { appid: "999", voice: "BV700" },
    });
    expect(next.tts_provider).toBe("cloud");
    expect(next.tts_cloud).toEqual({ appid: "999", voice: "BV700" });
  });

  it("should default tts fields to undefined when absent", () => {
    const cfg = normalizeProfileConfig({});
    expect(cfg.tts_provider).toBeUndefined();
    expect(cfg.tts_cloud ?? undefined).toBeUndefined();
  });
});

describe("cronToggleRefusalReason — WS bridge refusal contract", () => {
  it("reads the reason from BridgeRpcError data.detail", () => {
    const err = new BridgeRpcError(
      -32602,
      "cron/toggle: REST returned 409 conflict",
      { detail: "gateway_running", rest_status: 409 },
    );
    expect(cronToggleRefusalReason(err)).toBe("gateway_running");
  });

  it("returns null for a BridgeRpcError without string detail", () => {
    const err = new BridgeRpcError(-32001, "auth required", {
      kind: "auth_unavailable",
    });
    expect(cronToggleRefusalReason(err)).toBeNull();
  });

  it("returns null for plain errors (legacy REST body parsing is gone)", () => {
    const err = new Error(
      JSON.stringify({ ok: false, reason: "gateway_running" }),
    );
    expect(cronToggleRefusalReason(err)).toBeNull();
  });
});
