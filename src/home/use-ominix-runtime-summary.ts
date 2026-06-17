import { useEffect, useState } from "react";
import {
  fetchOminixRuntimeStatus,
  type OminixRuntimeStatus,
} from "@/settings/settings-api";

export type OminixRuntimeTone = "default" | "success" | "warning" | "danger";

export interface OminixRuntimeSummary {
  label: string;
  tone: OminixRuntimeTone;
  ready: boolean;
  loading: boolean;
  canRepair: boolean;
  state: string;
  refresh: () => Promise<void>;
}

type OminixRuntimeSnapshot = Omit<OminixRuntimeSummary, "refresh">;

const POLL_MS = 10_000;

const INITIAL_SUMMARY: OminixRuntimeSnapshot = {
  label: "Checking voice engine",
  tone: "default",
  ready: false,
  loading: true,
  canRepair: false,
  state: "checking",
};

let cachedSummary: OminixRuntimeSnapshot = INITIAL_SUMMARY;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(summary: OminixRuntimeSnapshot) => void>();

function emit(summary: OminixRuntimeSnapshot) {
  cachedSummary = summary;
  listeners.forEach((listener) => listener(summary));
}

export function summarizeOminixRuntime(runtime: OminixRuntimeStatus): OminixRuntimeSnapshot {
  if (runtime.health.healthy) {
    return {
      label: "Voice engine ready",
      tone: "success",
      ready: true,
      loading: false,
      canRepair: runtime.can_repair,
      state: runtime.state,
    };
  }

  if (runtime.can_repair) {
    return {
      label: "Voice engine needs repair",
      tone: "warning",
      ready: false,
      loading: false,
      canRepair: true,
      state: runtime.state,
    };
  }

  if (
    runtime.suggested_action === "install_ominix_api_binary" ||
    !runtime.binary_installed
  ) {
    return {
      label: "Voice engine not installed",
      tone: "warning",
      ready: false,
      loading: false,
      canRepair: true,
      state: runtime.state,
    };
  }

  return {
    label: "Voice engine unavailable",
    tone: "danger",
    ready: false,
    loading: false,
    canRepair: false,
    state: runtime.state,
  };
}

export function refreshOminixRuntimeSummary(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetchOminixRuntimeStatus()
    .then((runtime) => {
      emit(summarizeOminixRuntime(runtime));
    })
    .catch(() => {
      emit({
        label: "Voice engine check unavailable",
        tone: "warning",
        ready: false,
        loading: false,
        canRepair: false,
        state: "unknown",
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useOminixRuntimeSummary() {
  const [summary, setSummary] = useState<OminixRuntimeSnapshot>(cachedSummary);

  useEffect(() => {
    listeners.add(setSummary);
    void refreshOminixRuntimeSummary();
    const timer = window.setInterval(() => {
      void refreshOminixRuntimeSummary();
    }, POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshOminixRuntimeSummary();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      listeners.delete(setSummary);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return { ...summary, refresh: refreshOminixRuntimeSummary };
}
