/**
 * feature-flags unit tests (Phase C-3, issue #69).
 */

import { afterEach, describe, expect, it } from "vitest";
import { isChatAppUiV1Enabled } from "./feature-flags";

afterEach(() => {
  window.localStorage.clear();
});

describe("isChatAppUiV1Enabled", () => {
  it("returns false when localStorage is unset (default OFF)", () => {
    expect(isChatAppUiV1Enabled()).toBe(false);
  });

  it("returns true when localStorage is set to '1'", () => {
    window.localStorage.setItem("chat_app_ui_v1", "1");
    expect(isChatAppUiV1Enabled()).toBe(true);
  });

  it("returns false when localStorage is set to '0'", () => {
    window.localStorage.setItem("chat_app_ui_v1", "0");
    expect(isChatAppUiV1Enabled()).toBe(false);
  });

  it("returns false for any non-'1' value (conservative)", () => {
    for (const v of ["true", "yes", "on", "enabled", "", " 1", "1 "]) {
      window.localStorage.setItem("chat_app_ui_v1", v);
      expect(isChatAppUiV1Enabled()).toBe(false);
    }
  });

  it("does not read other flags (octos_thread_store_v2 is independent)", () => {
    window.localStorage.setItem("octos_thread_store_v2", "1");
    expect(isChatAppUiV1Enabled()).toBe(false);
  });
});
