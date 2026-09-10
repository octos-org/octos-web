import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getMyProfileStatus } from "@/settings/settings-api";

import type { SlidesProject, Slide, SlideEditDocument } from "../types";
import { getIdentityGeneration, getToken } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import { sendMessage } from "@/runtime/ui-protocol-send";
import { useSlidesProject, updateSlidesProject } from "../store";
import { fetchSlidesManifest, listSlidesFiles, fetchSlideEdits, saveSlideEdits, slideEditsAreRendered } from "../api";

interface SlidesContextValue {
  project: SlidesProject | undefined;
  editError: string | null;
  savingEdits: boolean;
  renderingEdits: boolean;
  retryEdits: () => void;
  save: (update: Partial<SlidesProject>) => void;
  reload: () => void;
  /** Update a single slide by index. */
  updateSlide: (index: number, update: Partial<Slide>) => Promise<boolean>;
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
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdits, setSavingEdits] = useState(false);
  const [renderingEdits, setRenderingEdits] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const saveBusy = useRef(false);
  const owner = useRef({ identity: getIdentityGeneration(), token: getToken() });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isCurrent = useCallback(() => mounted.current
    && owner.current.identity === getIdentityGeneration() && owner.current.token === getToken(), []);

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
        let latest = projectRef.current;
        if (!latest?.slug) return;
        const edits = await fetchSlideEdits(latest.id, latest.slug);
        if (stopped || !isCurrent()) return;
        if (projectRef.current?.manualEdits?.revision !== latest.manualEdits?.revision) return;
        // A fresh browser restores the saved edit model before interpreting
        // generated artifacts. Polling may never reverse pending edits.
        if (edits && edits.revision !== latest.manualEdits?.revision) {
          latest = { ...latest, manualEdits: edits, slides: edits.slides };
          updateSlidesProject(latest.id, { manualEdits: edits, slides: edits.slides });
          projectRef.current = latest;
          reload();
        }

        const profileStatus = await getMyProfileStatus();
        if (stopped || !isCurrent()) return;
        if (profileStatus?.running === false) {
          idleStreak += 1;
          return;
        }

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
        if (stopped || !isCurrent()) return;

        if (!latest.slug) return;
        const manifest = await fetchSlidesManifest(latest.slug, files);
        if (stopped || !isCurrent()) return;
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

        // A save that raced the network calls above owns the newest state.
        latest = projectRef.current;
        if (!latest?.slug) return;
        const pendingEdits = latest.manualEdits && latest.appliedEditRevision !== latest.manualEdits.revision
          ? latest.manualEdits : undefined;
        if (pendingEdits && !await slideEditsAreRendered(latest.slug, pendingEdits, manifest, files)) {
          idleStreak += 1;
          return;
        }
        if (stopped || !isCurrent() || projectRef.current?.manualEdits?.revision !== latest.manualEdits?.revision) return;

        const existingByAsset = new Map<string, Slide>();
        for (const slide of latest.slides) {
          const assetKey = slideAssetKey(slide.thumbnailUrl);
          if (assetKey) {
            existingByAsset.set(assetKey, slide);
          }
        }
        const hasExistingAssets = existingByAsset.size > 0;

        const nextSlides: Slide[] = manifest.slides.map((file, index) => {
          const existing = pendingEdits?.slides[index] ?? existingByAsset.get(file.filename)
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

        if (slidesChanged || manifestStampChanged || pendingEdits) {
          idleStreak = 0;
          updateSlidesProject(latest.id, {
            slides: nextSlides,
            manifestGeneratedAt: manifest.generatedAt,
            ...(manifest.outFile ? { pptxPath: manifest.outFile, pptxUrl: buildFileUrl(manifest.outFile) } : {}),
            ...(pendingEdits ? { appliedEditRevision: pendingEdits.revision } : {}),
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
  }, [project?.id, project?.scaffolded, project?.slug, reload, pollTick, isCurrent]);

  const regenerate = useCallback((p: SlidesProject, document: SlideEditDocument) => {
    if (!p.slug || !isCurrent()) return;
    setRenderingEdits(true);
    setEditError(null);
    const currentRevision = () => isCurrent() && projectRef.current?.manualEdits?.revision === document.revision;
    sendMessage({
      sessionId: p.id, historyTopic: `slides ${p.slug}`, media: [],
      text: `Apply my saved slide edits from slides/${p.slug}/manual-edits.json, revision ${document.revision}. `
        + `First verify that the file still has this revision; stop if it was superseded. `
        + `Update script.js to match every slide's requested title, notes, layout, and the exact array order (including additions/deletions). `
        + `Regenerate all PNG previews and the PPTX using the slides workflow. Do not reuse stale outputs. `
        + `Only after successful rendering, verify the current edit revision again and write slides/${p.slug}/manual-edits-applied.json `
        + `containing {"revision":"${document.revision}"}. Do not write that marker on failure.`,
      onError: (error) => { if (currentRevision()) setEditError(error.message); },
      onComplete: () => {
        if (!currentRevision()) return;
        setRenderingEdits(false);
        setPollTick((value) => value + 1);
      },
    });
  }, [isCurrent]);

  const persistEdits = useCallback(async (slides: Slide[]) => {
    const p = projectRef.current;
    if (!p || saveBusy.current || !isCurrent()) return false;
    if (slides.length === 0) { setEditError("A presentation must contain at least one slide."); return false; }
    saveBusy.current = true;
    setSavingEdits(true);
    setEditError(null);
    try {
      const document = await saveSlideEdits(p, slides);
      if (!isCurrent()) return false;
      const updated = updateSlidesProject(p.id, { slides: document.slides, manualEdits: document });
      projectRef.current = updated;
      reload();
      if (updated) regenerate(updated, document);
      return true;
    } catch (error) {
      if (isCurrent()) setEditError(error instanceof Error ? error.message : "Unable to save slide edits.");
      return false;
    } finally {
      saveBusy.current = false;
      if (isCurrent()) setSavingEdits(false);
    }
  }, [isCurrent, regenerate, reload]);

  const updateSlide = useCallback((index: number, update: Partial<Slide>) => {
    const p = projectRef.current;
    return p ? persistEdits(p.slides.map((slide, i) => i === index ? { ...slide, ...update, index: i } : slide)) : Promise.resolve(false);
  }, [persistEdits]);
  const addSlide = useCallback((slide: Omit<Slide, "index">, at?: number) => {
    const p = projectRef.current;
    if (!p) return;
    const slides = [...p.slides];
    slides.splice(at ?? slides.length, 0, { ...slide, index: 0 });
    void persistEdits(slides.map((item, index) => ({ ...item, index })));
  }, [persistEdits]);
  const removeSlide = useCallback((index: number) => {
    const p = projectRef.current;
    if (p) void persistEdits(p.slides.filter((_, i) => i !== index).map((slide, i) => ({ ...slide, index: i })));
  }, [persistEdits]);
  const moveSlide = useCallback((from: number, to: number) => {
    const p = projectRef.current;
    if (!p || from === to || from < 0 || to < 0 || from >= p.slides.length || to >= p.slides.length) return;
    const slides = [...p.slides];
    const [moved] = slides.splice(from, 1);
    slides.splice(to, 0, moved);
    void persistEdits(slides.map((slide, index) => ({ ...slide, index })));
  }, [persistEdits]);
  const retryEdits = useCallback(() => {
    const p = projectRef.current;
    if (p?.manualEdits && !renderingEdits) regenerate(p, p.manualEdits);
  }, [regenerate, renderingEdits]);

  return (
    <SlidesContext.Provider
      value={{
        project,
        editError,
        savingEdits,
        renderingEdits,
        retryEdits,
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
