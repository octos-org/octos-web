import { useCallback, useEffect, useState } from "react";

export type SvgTeacherSkin = "ocean" | "coral" | "scholar" | "starlight";
export type ModelTeacherSkin = "panda-3d" | "penguin-3d" | "bee-3d";
export type TeacherSkin = SvgTeacherSkin | ModelTeacherSkin;

export type TeacherActivity =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type TeacherSkinDefinition =
  | {
      id: SvgTeacherSkin;
      kind: "svg";
      label: string;
      description: string;
    }
  | {
      id: ModelTeacherSkin;
      kind: "model";
      label: string;
      description: string;
      modelPath: string;
      fallbackSkin: SvgTeacherSkin;
      cameraOrbit: string;
      animationByActivity: Partial<Record<TeacherActivity, string>>;
      reactionAnimation?: string;
    };

export const TEACHER_SKINS: readonly TeacherSkinDefinition[] = [
  {
    id: "ocean",
    kind: "svg",
    label: "Ocean",
    description: "The calm blue Octos classroom companion.",
  },
  {
    id: "coral",
    kind: "svg",
    label: "Coral",
    description: "A warm, cheerful look inspired by coral reefs.",
  },
  {
    id: "scholar",
    kind: "svg",
    label: "Scholar",
    description: "Round glasses and a tiny cap for focused study.",
  },
  {
    id: "starlight",
    kind: "svg",
    label: "Starlight",
    description: "A deep-space Octos with a soft cosmic glow.",
  },
  {
    id: "panda-3d",
    kind: "model",
    label: "Panda Pal",
    description: "A round little study buddy who nods, dances, and jumps.",
    modelPath: "models/companions/panda.glb",
    fallbackSkin: "scholar",
    cameraOrbit: "0deg 82deg 112%",
    animationByActivity: {
      idle: "MonsterArmature|Idle",
      listening: "MonsterArmature|Yes",
      thinking: "MonsterArmature|Idle",
      speaking: "MonsterArmature|Dance",
      error: "MonsterArmature|No",
    },
    reactionAnimation: "MonsterArmature|Jump",
  },
  {
    id: "penguin-3d",
    kind: "model",
    label: "Pocket Penguin",
    description: "A tiny, bright-eyed penguin with a gentle breathing idle.",
    modelPath: "models/companions/penguin.glb",
    fallbackSkin: "ocean",
    cameraOrbit: "0deg 82deg 110%",
    animationByActivity: {
      idle: "MonsterArmature|Idle",
      listening: "MonsterArmature|Idle",
      thinking: "MonsterArmature|Idle",
      speaking: "MonsterArmature|Idle",
      error: "MonsterArmature|Idle",
    },
  },
  {
    id: "bee-3d",
    kind: "model",
    label: "Bumble Buddy",
    description: "A cheerful flying helper who hovers beside each lesson.",
    modelPath: "models/companions/bee.glb",
    fallbackSkin: "coral",
    cameraOrbit: "0deg 80deg 118%",
    animationByActivity: {
      idle: "MonsterArmature|Flying",
      listening: "MonsterArmature|Flying",
      thinking: "MonsterArmature|Flying",
      speaking: "MonsterArmature|Flying",
      error: "MonsterArmature|Flying",
    },
  },
];

const STORAGE_KEY = "octos-teacher-skin";
const CHANGE_EVENT = "octos-teacher-skin-change";

export function isTeacherSkin(value: unknown): value is TeacherSkin {
  return TEACHER_SKINS.some((skin) => skin.id === value);
}

export function getTeacherSkinDefinition(
  skin: TeacherSkin,
): TeacherSkinDefinition {
  return TEACHER_SKINS.find((entry) => entry.id === skin) ?? TEACHER_SKINS[0];
}

export function resolveInitialTeacherSkin(): TeacherSkin {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isTeacherSkin(stored) ? stored : "ocean";
}

export function applyTeacherSkin(skin: TeacherSkin): void {
  localStorage.setItem(STORAGE_KEY, skin);
}

export function useTeacherSkin() {
  const [skin, setSkinState] = useState<TeacherSkin>(resolveInitialTeacherSkin);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = event instanceof CustomEvent ? event.detail : null;
      if (isTeacherSkin(next)) setSkinState(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setSkinState(resolveInitialTeacherSkin());
      }
    };

    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setSkin = useCallback((next: TeacherSkin) => {
    applyTeacherSkin(next);
    setSkinState(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  return { skin, setSkin };
}
