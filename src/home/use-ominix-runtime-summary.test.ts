import { describe, expect, it } from "vitest";
import {
  summarizeOminixRuntime,
  type OminixRuntimeSummary,
} from "./use-ominix-runtime-summary";
import type { OminixRuntimeStatus } from "@/settings/settings-api";

function runtime(overrides: Partial<OminixRuntimeStatus>): OminixRuntimeStatus {
  return {
    state: "healthy",
    url: "http://127.0.0.1:8081",
    url_source: "env",
    port: 8081,
    home_dir: "/tmp",
    ominix_dir: "/tmp/.ominix",
    binary_path: "/tmp/bin/ominix-api",
    binary_installed: true,
    metallib_path: "/tmp/bin/mlx.metallib",
    metallib_installed: true,
    models_dir: "/tmp/models",
    models_dir_exists: true,
    plist_path: "/tmp/Library/LaunchAgents/io.ominix.ominix-api.plist",
    plist_exists: true,
    plist_port: 8081,
    discovery_path: "/tmp/.ominix/api_url",
    discovery_url: "http://127.0.0.1:8081",
    service_registered: true,
    service_running: true,
    launchctl_skipped: false,
    health: { healthy: true, http_status: 200 },
    issues: [],
    can_repair: true,
    suggested_action: "ready",
    ...overrides,
  };
}

function stripRefresh(summary: Omit<OminixRuntimeSummary, "refresh">) {
  return summary;
}

describe("summarizeOminixRuntime", () => {
  it("marks a healthy runtime as ready", () => {
    expect(stripRefresh(summarizeOminixRuntime(runtime({})))).toMatchObject({
      label: "Voice engine ready",
      tone: "success",
      ready: true,
      loading: false,
    });
  });

  it("marks a repairable runtime as warning", () => {
    expect(
      stripRefresh(summarizeOminixRuntime(
        runtime({
          state: "missing_plist",
          health: { healthy: false },
          service_registered: false,
          can_repair: true,
          suggested_action: "repair",
        }),
      )),
    ).toMatchObject({
      label: "Voice engine needs repair",
      tone: "warning",
      ready: false,
      canRepair: true,
      state: "missing_plist",
    });
  });

  it("marks a missing binary runtime as installable", () => {
    expect(
      stripRefresh(summarizeOminixRuntime(
        runtime({
          state: "missing_binary",
          health: { healthy: false },
          binary_installed: false,
          can_repair: false,
          suggested_action: "install_ominix_api_binary",
        }),
      )),
    ).toMatchObject({
      label: "Voice engine not installed",
      tone: "warning",
      ready: false,
      canRepair: true,
      state: "missing_binary",
    });
  });
});
