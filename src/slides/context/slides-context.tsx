import { createContext, useContext, useCallback, useRef, type ReactNode } from "react";
import type { SlidesProject, Slide } from "../types";
import { useSlidesProject, updateSlidesProject } from "../store";

interface SlidesContextValue {
  project: SlidesProject | undefined;
  save: (update: Partial<SlidesProject>) => void;
  reload: () => void;
  /** Update a single slide by index. */
  updateSlide: (index: number, update: Partial<Slide>) => void;
  /** Add a new slide at the end (or at a specific position). */
  addSlide: (slide: Omit<Slide, "index">, at?: number) => void;
  /** Remove a slide by index. */
  removeSlide: (index: number) => void;
  /** Reorder slides (move from one index to another). */
  moveSlide: (from: number, to: number) => void;
}

const SlidesContext = createContext<SlidesContextValue | null>(null);

export function SlidesProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const { project, save, reload } = useSlidesProject(projectId);

  // Keep a ref to the latest project so callbacks never close over stale state
  const projectRef = useRef(project);
  projectRef.current = project;

  const updateSlide = useCallback(
    (index: number, update: Partial<Slide>) => {
      const p = projectRef.current;
      if (!p) return;
      const slides = p.slides.map((s) =>
        s.index === index ? { ...s, ...update } : s,
      );
      updateSlidesProject(p.id, { slides });
      reload();
    },
    [reload],
  );

  const addSlide = useCallback(
    (slide: Omit<Slide, "index">, at?: number) => {
      const p = projectRef.current;
      if (!p) return;
      const pos = at ?? p.slides.length;
      const newSlide: Slide = { ...slide, index: pos };
      const slides = [...p.slides];
      slides.splice(pos, 0, newSlide);
      // Re-index all slides
      const reindexed = slides.map((s, i) => ({ ...s, index: i }));
      updateSlidesProject(p.id, { slides: reindexed });
      reload();
    },
    [reload],
  );

  const removeSlide = useCallback(
    (index: number) => {
      const p = projectRef.current;
      if (!p) return;
      const slides = p.slides
        .filter((s) => s.index !== index)
        .map((s, i) => ({ ...s, index: i }));
      updateSlidesProject(p.id, { slides });
      reload();
    },
    [reload],
  );

  const moveSlide = useCallback(
    (from: number, to: number) => {
      const p = projectRef.current;
      if (!p) return;
      const slides = [...p.slides];
      const [moved] = slides.splice(from, 1);
      slides.splice(to, 0, moved);
      const reindexed = slides.map((s, i) => ({ ...s, index: i }));
      updateSlidesProject(p.id, { slides: reindexed });
      reload();
    },
    [reload],
  );

  return (
    <SlidesContext.Provider
      value={{
        project,
        save,
        reload,
        updateSlide,
        addSlide,
        removeSlide,
        moveSlide,
      }}
    >
      {children}
    </SlidesContext.Provider>
  );
}

export function useSlides() {
  const ctx = useContext(SlidesContext);
  if (!ctx) throw new Error("useSlides must be used within SlidesProvider");
  return ctx;
}
