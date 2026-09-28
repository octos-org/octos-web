import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as ProjectionStore from "@/store/projection-store";
import { loadSessionFiles } from "@/store/file-store";
import { watchSessionFiles } from "./session-file-watcher";
import type { ProjectionEnvelopeV2 } from "./projection-envelope-v2";

vi.mock("@/store/file-store", () => ({ loadSessionFiles: vi.fn(async () => {}) }));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); ProjectionStore.__resetProjectionForTests(); });
afterEach(() => { vi.useRealTimers(); ProjectionStore.__resetProjectionForTests(); });
function terminal(thread: string, seq = 1): ProjectionEnvelopeV2 {
  return { session_id: "session", thread_id: thread, turn_id: thread, seq,
    payload: { type: "turn_terminal", data: { outcome: "completed" } } };
}

it("refreshes generated files after a buffered terminal becomes canonical", async () => {
  const stop = watchSessionFiles("session");
  expect(loadSessionFiles).toHaveBeenCalledTimes(1);
  ProjectionStore.beginSnapshot("session");
  ProjectionStore.ingest("session", terminal("turn"));
  await vi.runAllTimersAsync();
  expect(loadSessionFiles).toHaveBeenCalledTimes(1);
  ProjectionStore.replaceSnapshot("session", []);
  await vi.runAllTimersAsync();
  expect(loadSessionFiles).toHaveBeenCalledTimes(2);
  ProjectionStore.ingest("session", terminal("turn"));
  await vi.runAllTimersAsync();
  expect(loadSessionFiles).toHaveBeenCalledTimes(2);
  stop();
});

it("coalesces history replay and excludes other topics", async () => {
  const stop = watchSessionFiles("session", "slides");
  const scope = ProjectionStore.projectionStoreKey("session", "slides");
  ProjectionStore.replaceSnapshot(scope, [terminal("one"), terminal("two")]);
  ProjectionStore.ingest("session", terminal("other-topic"));
  await vi.runAllTimersAsync();
  expect(loadSessionFiles).toHaveBeenCalledTimes(2);
  expect(loadSessionFiles).toHaveBeenLastCalledWith("session");
  stop();
});

it("cancels pending refresh and stops listening when the scope unmounts", async () => {
  const stop = watchSessionFiles("session");
  ProjectionStore.ingest("session", terminal("one"));
  stop();
  ProjectionStore.ingest("session", terminal("two"));
  await vi.runAllTimersAsync();
  expect(loadSessionFiles).toHaveBeenCalledTimes(1);
});
