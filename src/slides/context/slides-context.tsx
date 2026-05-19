import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

import type { SlidesProject, Slide } from "../types";
import { useSlidesProject, updateSlidesProject } from "../store";
import { fetchSlidesManifest, listSlidesFiles } from "../api";

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

  useEffect(() => {
    const current = projectRef.current;
    if (!current?.scaffolded || !current.slug) return;

    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let idleStreak = 0;

    function nextDelay(): number {
      if (idleStreak < 3) return 5000;
      if (idleStreak < 10) return 15_000;
      return 30_000;
    }

    function schedule() {
      if (stopped) return;
      pollTimer = setTimeout(() => {
        if (typeof document !== "undefined" && document.hidden) {
          schedule();
          return;
        }
        void pollSlideImages();
      }, nextDelay());
    }

    async function pollSlideImages() {
      try {
        const latest = projectRef.current;
        if (!latest?.slug) return;

        // List BOTH the scaffold dir and the plugin-output dir. The
        // `mofa_slides` plugin writes generated PNGs to
        // `skill-output/slides/<slug>/output/slide-NN.png`;
        // `synthesizeManifestFromImages` only matches files whose group
        // starts with `skill-output/slides/<slug>/output`. Listing only
        // `slides/<slug>` (the pre-fix shape) returned the scaffold
        // trio with no PNGs, so the synthesizer fell to `null` and the
        // preview never updated after a re-generation — the initial
        // hydrate sweep correctly listed both dirs, so the first paint
        // worked; subsequent renders did not.
        const files = await listSlidesFiles(
          [`slides/${latest.slug}`, `skill-output/slides/${latest.slug}`],
          { sessionId: latest.id },
        );
        if (stopped) return;

        const manifest = await fetchSlidesManifest(latest.slug, files);
        if (stopped) return;
        // Codex MAJOR (PR #142): a scaffolded project without any
        // generated images returns `manifest === null` here. Pre-fix
        // we `return`ed without bumping `idleStreak`, so the poller
        // stayed pinned at the 5 s base cadence forever for any deck
        // the agent has not started rendering yet. Treat null manifest
        // as a no-change tick.
        if (!manifest) {
          idleStreak += 1;
          return;
        }

        const existingByAsset = new Map<string, Slide>();
        for (const slide of latest.slides) {
          const assetKey = slideAssetKey(slide.thumbnailUrl);
          if (assetKey) {
            existingByAsset.set(assetKey, slide);
          }
        }
        const hasExistingAssets = existingByAsset.size > 0;

        const nextSlides: Slide[] = manifest.slides.map((file, index) => {
          const existing = existingByAsset.get(file.filename)
            ?? existingByAsset.get(slideAssetKey(file.path) ?? "")
            ?? (!hasExistingAssets ? latest.slides[index] : undefined);
          return {
            index,
            title: existing?.title || `Slide ${file.index + 1}`,
            notes: existing?.notes || "",
            layout: existing?.layout || (file.index === 0 ? "title" : "content"),
            thumbnailUrl: file.path,
          };
        });

        const slidesChanged =
          nextSlides.length !== latest.slides.length ||
          nextSlides.some((slide, index) => {
            const existing = latest.slides[index];
            return (
              !existing ||
              existing.thumbnailUrl !== slide.thumbnailUrl ||
              existing.title !== slide.title ||
              existing.notes !== slide.notes ||
              existing.layout !== slide.layout
            );
          });

        // Codex MAJOR (PR #142): also persist when only the
        // `generatedAt` cache-buster changes (same-path PNG
        // overwrite — the file content has changed but every slide's
        // `thumbnailUrl` is identical). The synthesizer's
        // `generatedAt` is derived deterministically from file mtimes
        // so this is a real "files-on-disk changed" signal, not the
        // pre-fix `new Date()` churn.
        const manifestStampChanged =
          !slidesChanged &&
          manifest.generatedAt !== latest.manifestGeneratedAt;

        if (slidesChanged || manifestStampChanged) {
          idleStreak = 0;
          updateSlidesProject(latest.id, {
            slides: nextSlides,
            manifestGeneratedAt: manifest.generatedAt,
          });
          reload();
        } else {
          idleStreak += 1;
        }
      } catch {
        // Codex MAJOR (PR #142): increment idleStreak on transport
        // failure too. Pre-fix the empty catch left the streak frozen
        // and the poller hammered 5 s while the backend was warming up
        // (or down).
        idleStreak += 1;
      } finally {
        schedule();
      }
    }

    void pollSlideImages();

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [project?.id, project?.scaffolded, project?.slug, reload]);

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

function slideAssetKey(path?: string): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const key = normalized.split("/").pop();
  return key || null;
}
