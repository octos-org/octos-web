import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceRow } from "./source-media";

const listSkillActionJobsMock = vi.hoisted(() => vi.fn(async () => []));
const listSkillActionsMock = vi.hoisted(() => vi.fn(async () => []));
const loadSourceCatalogMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/skill-actions", () => ({
  listSkillActions: listSkillActionsMock,
  listSkillActionJobs: listSkillActionJobsMock,
  skillActionScopeId: (sessionId: string, topic?: string) =>
    topic?.trim() && !sessionId.includes("#")
      ? `${sessionId}#${topic.trim()}`
      : sessionId,
}));
vi.mock("./source-store", () => ({
  loadSourceCatalog: loadSourceCatalogMock,
}));

import { useNotebookSources } from "./use-notebook-sources";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function readyRow(sourceId: string): SourceRow {
  return {
    sourceId,
    filename: `${sourceId}.md`,
    path: `notebook-sources/${sourceId}/source.md`,
    sourcePath: `notebook-sources/${sourceId}/source.md`,
    timestamp: 1,
    status: "ready",
  };
}

function supportedSourceActions() {
  return ["source.list", "source.import", "source.rename", "source.remove"].map(
    (id) => ({
      id,
      skill_id: "mofa-notebook-source",
      label: id,
      tags: ["notebook"],
      surfaces: ["studio.sources"],
      input_schema: {},
      execution: id === "source.list" ? "sync" : "background",
      available: true,
    }),
  );
}

beforeEach(() => {
  listSkillActionsMock.mockReset();
  listSkillActionsMock.mockResolvedValue(supportedSourceActions());
  listSkillActionJobsMock.mockClear();
  listSkillActionJobsMock.mockResolvedValue([]);
  loadSourceCatalogMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useNotebookSources", () => {
  it("does not call source RPCs when the negotiated action contract is incomplete", async () => {
    listSkillActionsMock.mockResolvedValue([
      {
        id: "source.list",
        skill_id: "mofa-notebook-source",
        label: "List sources",
        tags: ["notebook"],
        surfaces: ["studio.sources"],
        input_schema: {},
        execution: "sync",
        available: true,
      },
    ]);

    const { result } = renderHook(() => useNotebookSources("web-session"));

    await waitFor(() =>
      expect(result.current.sourcesCapability.status).toBe("unsupported"),
    );
    expect(result.current.sourcesCapability.reason).toContain(
      "source.import",
    );
    expect(listSkillActionsMock).toHaveBeenCalledWith(
      "web-session",
      "studio.sources",
      undefined,
    );
    expect(listSkillActionJobsMock).not.toHaveBeenCalled();
    expect(loadSourceCatalogMock).not.toHaveBeenCalled();
  });

  it("rechecks the scoped contract before source RPCs after reconnect", async () => {
    loadSourceCatalogMock.mockResolvedValue([]);
    const { result } = renderHook(() => useNotebookSources("web-session"));
    await waitFor(() =>
      expect(result.current.sourcesCapability.status).toBe("supported"),
    );
    await waitFor(() => expect(loadSourceCatalogMock).toHaveBeenCalled());

    listSkillActionJobsMock.mockClear();
    loadSourceCatalogMock.mockClear();
    const capabilityRefresh = deferred<ReturnType<typeof supportedSourceActions>>();
    listSkillActionsMock.mockReturnValueOnce(capabilityRefresh.promise);

    act(() => {
      window.dispatchEvent(new Event("crew:bridge_connected"));
    });
    expect(result.current.sourcesCapability.status).toBe("connecting");
    expect(listSkillActionJobsMock).not.toHaveBeenCalled();
    expect(loadSourceCatalogMock).not.toHaveBeenCalled();

    await act(async () => {
      capabilityRefresh.resolve(supportedSourceActions());
      await capabilityRefresh.promise;
    });
    await waitFor(() => expect(loadSourceCatalogMock).toHaveBeenCalled());
    expect(listSkillActionJobsMock).toHaveBeenCalledWith(
      "web-session",
      { actionId: "source.import" },
      undefined,
    );
  });

  it("ignores a source job response from before a bridge reconnect", async () => {
    const staleRestore = deferred<unknown[]>();
    listSkillActionJobsMock
      .mockReturnValueOnce(staleRestore.promise)
      .mockResolvedValueOnce([]);
    loadSourceCatalogMock.mockResolvedValue([]);

    const { result } = renderHook(() => useNotebookSources("web-session"));
    await waitFor(() => expect(listSkillActionJobsMock).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new Event("crew:bridge_connected")));
    await waitFor(() =>
      expect(result.current.sourcesCapability.status).toBe("supported"),
    );
    await waitFor(() => expect(listSkillActionJobsMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      staleRestore.resolve([
        {
          job_id: "stale-job",
          batch_id: "stale-batch",
          profile_id: "profile-1",
          session_id: "web-session",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "running",
          input_path: "uploads/stale.pdf",
          filename: "stale.pdf",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:01:00Z",
        },
      ]);
      await staleRestore.promise;
    });

    expect(result.current.uploadedSources).toEqual([]);
  });

  it("ignores a stale capability response after a newer reconnect", async () => {
    loadSourceCatalogMock.mockResolvedValue([]);
    const { result } = renderHook(() => useNotebookSources("web-session"));
    await waitFor(() =>
      expect(result.current.sourcesCapability.status).toBe("supported"),
    );

    const stale = deferred<ReturnType<typeof supportedSourceActions>>();
    const current = deferred<ReturnType<typeof supportedSourceActions>>();
    listSkillActionsMock
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);

    act(() => window.dispatchEvent(new Event("crew:bridge_connected")));
    act(() => window.dispatchEvent(new Event("crew:bridge_connected")));

    await act(async () => {
      current.resolve(supportedSourceActions());
      await current.promise;
    });
    await waitFor(() =>
      expect(result.current.sourcesCapability.status).toBe("supported"),
    );

    await act(async () => {
      stale.resolve([]);
      await stale.promise;
    });
    expect(result.current.sourcesCapability.status).toBe("supported");
  });

  it("does not let a delayed catalog response cross a session switch", async () => {
    const first = deferred<SourceRow[]>();
    const second = deferred<SourceRow[]>();
    loadSourceCatalogMock.mockImplementation((sessionId: string) =>
      sessionId === "web-first" ? first.promise : second.promise,
    );

    const { result, rerender } = renderHook(
      ({ sessionId }) => useNotebookSources(sessionId),
      { initialProps: { sessionId: "web-first" } },
    );
    await waitFor(() =>
      expect(loadSourceCatalogMock).toHaveBeenCalledWith(
        "web-first",
        undefined,
      ),
    );

    rerender({ sessionId: "web-second" });
    await waitFor(() =>
      expect(loadSourceCatalogMock).toHaveBeenCalledWith(
        "web-second",
        undefined,
      ),
    );
    expect(result.current.uploadedSources).toEqual([]);

    await act(async () => {
      first.resolve([readyRow("old")]);
      await first.promise;
    });
    expect(result.current.uploadedSources).toEqual([]);

    await act(async () => {
      second.resolve([readyRow("new")]);
      await second.promise;
    });
    await waitFor(() =>
      expect(result.current.uploadedSources).toEqual([readyRow("new")]),
    );
  });

  it("reconciles a completed import job through the authoritative catalog", async () => {
    loadSourceCatalogMock.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useNotebookSources("web-session"));
    await waitFor(() => expect(result.current.sourcesLoading).toBe(false));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:skill_action_job_updated", {
          detail: {
            job_id: "job-1",
            batch_id: "batch-1",
            profile_id: "profile-1",
            session_id: "web-session",
            action_id: "source.import",
            skill_id: "mofa-notebook-source",
            status: "running",
            input_path: "uploads/notes.md",
            filename: "notes.md",
            created_at: "2026-07-09T01:00:00Z",
            updated_at: "2026-07-09T01:01:00Z",
          },
        }),
      );
    });
    expect(result.current.uploadedSources[0]?.status).toBe("processing");

    loadSourceCatalogMock.mockResolvedValueOnce([readyRow("notes")]);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:skill_action_job_updated", {
          detail: {
            job_id: "job-1",
            batch_id: "batch-1",
            profile_id: "profile-1",
            session_id: "web-session",
            action_id: "source.import",
            skill_id: "mofa-notebook-source",
            status: "succeeded",
            input_path: "uploads/notes.md",
            filename: "notes.md",
            source_id: "notes",
            source_path: "notebook-sources/notes/source.md",
            created_at: "2026-07-09T01:00:00Z",
            updated_at: "2026-07-09T01:02:00Z",
          },
        }),
      );
    });

    await waitFor(() =>
      expect(result.current.uploadedSources).toEqual([readyRow("notes")]),
    );
  });

  it("does not resurrect a running row from a stale job list after success", async () => {
    const staleRestore = deferred<unknown[]>();
    listSkillActionJobsMock.mockReturnValueOnce(staleRestore.promise);
    loadSourceCatalogMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([readyRow("notes")]);

    const { result } = renderHook(() => useNotebookSources("web-session"));
    await waitFor(() => expect(listSkillActionJobsMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.sourcesLoading).toBe(false));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:skill_action_job_updated", {
          detail: {
            job_id: "job-1",
            batch_id: "batch-1",
            profile_id: "profile-1",
            session_id: "web-session",
            action_id: "source.import",
            skill_id: "mofa-notebook-source",
            status: "succeeded",
            input_path: "uploads/notes.md",
            filename: "notes.md",
            source_id: "notes",
            source_path: "notebook-sources/notes/source.md",
            created_at: "2026-07-09T01:00:00Z",
            updated_at: "2026-07-09T01:02:00Z",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(result.current.uploadedSources).toEqual([readyRow("notes")]),
    );

    await act(async () => {
      staleRestore.resolve([
        {
          job_id: "job-1",
          batch_id: "batch-1",
          profile_id: "profile-1",
          session_id: "web-session",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "running",
          input_path: "uploads/notes.md",
          filename: "notes.md",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:01:00Z",
        },
      ]);
      await staleRestore.promise;
    });

    expect(result.current.uploadedSources).toEqual([readyRow("notes")]);
  });
});
