import { useEffect, useRef, useState } from "react";
import type { ModelViewerElement } from "@google/model-viewer";

import {
  getTeacherSkinDefinition,
  type TeacherActivity,
  type TeacherSkinDefinition,
  type TeacherSkin,
} from "@/hooks/use-teacher-skin";

import { OctosAvatar } from "./octos-avatar";
import "./octos-skin-art.css";

function publicAsset(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

export function OctosSkinArt({
  skin,
  className = "",
  eager = false,
  activity = "idle",
  reactionKey = 0,
}: {
  skin: TeacherSkin;
  className?: string;
  eager?: boolean;
  activity?: TeacherActivity;
  reactionKey?: number;
}) {
  const definition = getTeacherSkinDefinition(skin);

  if (definition.kind === "svg") {
    return <OctosAvatar skin={definition.id} className={className} />;
  }

  return (
    <OctosModelArt
      key={definition.id}
      definition={definition}
      className={className}
      eager={eager}
      activity={activity}
      reactionKey={reactionKey}
    />
  );
}

function OctosModelArt({
  definition,
  className,
  eager,
  activity,
  reactionKey,
}: {
  definition: Extract<TeacherSkinDefinition, { kind: "model" }>;
  className: string;
  eager: boolean;
  activity: TeacherActivity;
  reactionKey: number;
}) {
  const viewerRef = useRef<ModelViewerElement | null>(null);
  const handledReactionKeyRef = useRef(reactionKey);
  const [runtimeReady, setRuntimeReady] = useState(
    () =>
      typeof customElements !== "undefined" &&
      customElements.get("model-viewer") !== undefined,
  );
  const [modelReady, setModelReady] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [failed, setFailed] = useState(
    () => typeof window === "undefined" || !("WebGLRenderingContext" in window),
  );
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  const modelSrc = publicAsset(definition.modelPath);
  const baseAnimation =
    definition.animationByActivity[activity] ??
    definition.animationByActivity.idle;

  useEffect(() => {
    const mediaQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mediaQuery) return;

    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setReacting(false);
      setReducedMotion(event.matches);
    };
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (runtimeReady || failed) return;

    let cancelled = false;
    void import("@google/model-viewer")
      .then(() => {
        if (!cancelled) setRuntimeReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [failed, runtimeReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!runtimeReady || failed || !viewer) return;

    const onLoad = () => setModelReady(true);
    const onError = () => setFailed(true);
    viewer.addEventListener("load", onLoad);
    viewer.addEventListener("error", onError);
    viewer.setAttribute("src", modelSrc);
    viewer.setAttribute("alt", `${definition.label} learning companion`);
    viewer.setAttribute("loading", eager ? "eager" : "lazy");
    viewer.setAttribute("inert", "");
    if (viewer.loaded) setModelReady(true);

    return () => {
      viewer.removeEventListener("load", onLoad);
      viewer.removeEventListener("error", onError);
    };
  }, [definition.label, eager, failed, modelSrc, runtimeReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!modelReady || !viewer) return;

    if (reducedMotion) {
      viewer.pause();
      return;
    }
    if (
      !reacting &&
      baseAnimation &&
      viewer.availableAnimations.includes(baseAnimation)
    ) {
      viewer.animationCrossfadeDuration = 180;
      viewer.animationName = baseAnimation;
      viewer.currentTime = 0;
      viewer.play();
    }
  }, [baseAnimation, modelReady, reacting, reducedMotion]);

  // Pause the idle animation while the tab is hidden (audit M7): the
  // 3D companion would otherwise keep cycling its animation on
  // always-on displays with the tab backgrounded.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!modelReady || !viewer || reducedMotion) return;
    const onVisibility = () => {
      if (document.hidden) {
        viewer.pause();
      } else if (!reacting) {
        viewer.currentTime = 0;
        viewer.play();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [modelReady, reacting, reducedMotion]);

  useEffect(() => {
    const isNewReaction = reactionKey !== handledReactionKeyRef.current;
    if (isNewReaction) handledReactionKeyRef.current = reactionKey;

    if (reducedMotion) return;

    const viewer = viewerRef.current;
    if (!isNewReaction || !modelReady || !viewer) return;

    let finished = false;
    const finishReaction = () => {
      if (finished) return;
      finished = true;
      setReacting(false);
    };
    const timeout = window.setTimeout(finishReaction, 900);
    const reactionAnimation = definition.reactionAnimation;

    setReacting(true);
    if (
      reactionAnimation &&
      viewer.availableAnimations.includes(reactionAnimation)
    ) {
      viewer.animationCrossfadeDuration = 120;
      viewer.animationName = reactionAnimation;
      viewer.currentTime = 0;
      viewer.play({ repetitions: 1, pingpong: false });
      viewer.addEventListener("finished", finishReaction, { once: true });
    }

    return () => {
      window.clearTimeout(timeout);
      viewer.removeEventListener("finished", finishReaction);
    };
  }, [definition.reactionAnimation, modelReady, reactionKey, reducedMotion]);

  return (
    <span
      className={`octos-model-art ${className}`}
      data-activity={activity}
      data-ready={modelReady && runtimeReady && !failed ? "true" : undefined}
      data-failed={failed ? "true" : undefined}
      data-reacting={reacting ? "true" : undefined}
    >
      <OctosAvatar
        skin={definition.fallbackSkin}
        className="octos-model-fallback"
      />
      {runtimeReady && !failed && (
        <model-viewer
          ref={viewerRef}
          aria-hidden="true"
          tabIndex={-1}
          camera-orbit={definition.cameraOrbit}
          field-of-view="36deg"
          interaction-prompt="none"
          shadow-intensity="0"
          exposure="1.15"
          autoplay={!reducedMotion}
        />
      )}
      {!modelReady && !failed && (
        <span className="octos-model-loading" aria-hidden="true" />
      )}
    </span>
  );
}
