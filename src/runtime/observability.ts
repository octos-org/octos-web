type CounterLabels = Record<string, string>;

interface RuntimeMetricsState {
  counters: Record<string, number>;
}

declare global {
  interface Window {
    __octosRuntimeMetrics?: RuntimeMetricsState;
  }
}

function getRuntimeMetricsState(): RuntimeMetricsState | null {
  if (typeof window === "undefined") return null;
  window.__octosRuntimeMetrics ??= { counters: {} };
  return window.__octosRuntimeMetrics;
}

function metricKey(name: string, labels: CounterLabels): string {
  const encoded = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return encoded ? `${name}{${encoded}}` : name;
}

export function recordRuntimeCounter(
  name: string,
  labels: CounterLabels,
  increment = 1,
): void {
  const state = getRuntimeMetricsState();
  if (!state) return;
  const key = metricKey(name, labels);
  state.counters[key] = (state.counters[key] ?? 0) + increment;
}
