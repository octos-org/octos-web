import { createContext, useContext, useCallback, type ReactNode } from "react";
import type { StudioProject, StudioSource, StudioOutput } from "../types";
import { useStudioProject, generateSourceId, generateOutputId, updateProject } from "../store";

interface StudioContextValue {
  project: StudioProject | undefined;
  save: (update: Partial<StudioProject>) => void;
  reload: () => void;
  addSource: (source: Omit<StudioSource, "id" | "addedAt" | "selected">) => void;
  removeSource: (sourceId: string) => void;
  toggleSource: (sourceId: string) => void;
  selectAllSources: (selected: boolean) => void;
  addOutput: (output: Omit<StudioOutput, "id" | "createdAt">) => void;
  updateOutput: (outputId: string, update: Partial<StudioOutput>) => void;
  selectedSources: StudioSource[];
}

const StudioContext = createContext<StudioContextValue | null>(null);

export function StudioProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const { project, save, reload } = useStudioProject(projectId);

  const addSource = useCallback(
    (source: Omit<StudioSource, "id" | "addedAt" | "selected">) => {
      if (!project) return;
      const newSource: StudioSource = {
        ...source,
        id: generateSourceId(),
        addedAt: Date.now(),
        selected: true,
      };
      save({ sources: [...project.sources, newSource] });
    },
    [project, save],
  );

  const removeSource = useCallback(
    (sourceId: string) => {
      if (!project) return;
      save({ sources: project.sources.filter((s) => s.id !== sourceId) });
    },
    [project, save],
  );

  const toggleSource = useCallback(
    (sourceId: string) => {
      if (!project) return;
      save({
        sources: project.sources.map((s) =>
          s.id === sourceId ? { ...s, selected: !s.selected } : s,
        ),
      });
    },
    [project, save],
  );

  const selectAllSources = useCallback(
    (selected: boolean) => {
      if (!project) return;
      save({ sources: project.sources.map((s) => ({ ...s, selected })) });
    },
    [project, save],
  );

  const addOutput = useCallback(
    (output: Omit<StudioOutput, "id" | "createdAt">) => {
      if (!project) return;
      const newOutput: StudioOutput = {
        ...output,
        id: generateOutputId(),
        createdAt: Date.now(),
      };
      save({ outputs: [...project.outputs, newOutput] });
      return newOutput.id;
    },
    [project, save],
  );

  const updateOutput = useCallback(
    (outputId: string, update: Partial<StudioOutput>) => {
      if (!project) return;
      const outputs = project.outputs.map((o) =>
        o.id === outputId ? { ...o, ...update } : o,
      );
      // Use updateProject directly to avoid stale closure
      updateProject(project.id, { outputs });
      reload();
    },
    [project, reload],
  );

  const selectedSources = project?.sources.filter((s) => s.selected) ?? [];

  return (
    <StudioContext.Provider
      value={{
        project,
        save,
        reload,
        addSource,
        removeSource,
        toggleSource,
        selectAllSources,
        addOutput,
        updateOutput,
        selectedSources,
      }}
    >
      {children}
    </StudioContext.Provider>
  );
}

export function useStudio() {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error("useStudio must be used within StudioProvider");
  return ctx;
}
