import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({
  callMethod: vi.fn(),
  ensureAuxBridge: vi.fn(),
}));

vi.mock("@/runtime/ui-protocol-runtime", () => ({
  ensureAuxBridge: runtimeMock.ensureAuxBridge,
}));

import { listSessions } from "./sessions";

describe("session auxiliary RPCs", () => {
  beforeEach(() => {
    runtimeMock.callMethod.mockReset();
    runtimeMock.ensureAuxBridge.mockReset();
    runtimeMock.ensureAuxBridge.mockResolvedValue({
      callMethod: runtimeMock.callMethod,
    });
  });

  it("waits for an auxiliary bridge before listing sessions", async () => {
    runtimeMock.callMethod.mockResolvedValue({
      sessions: [
        { id: "learn-123", message_count: 2, title: "负数乘法" },
      ],
    });

    await expect(listSessions()).resolves.toEqual([
      { id: "learn-123", message_count: 2, title: "负数乘法" },
    ]);
    expect(runtimeMock.ensureAuxBridge).toHaveBeenCalledTimes(1);
    expect(runtimeMock.callMethod).toHaveBeenCalledWith("session/list", {});
  });
});
