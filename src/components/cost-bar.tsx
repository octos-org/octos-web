import { useEffect, useState } from "react";

interface CostState {
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
}

export function CostBar({
  model,
  provider,
}: {
  model?: string;
  provider?: string;
}) {
  const [cost, setCost] = useState<CostState>({
    inputTokens: 0,
    outputTokens: 0,
    cost: null,
  });

  useEffect(() => {
    function handler(e: Event) {
      const d = (e as CustomEvent).detail;
      setCost({
        inputTokens: d.input_tokens ?? 0,
        outputTokens: d.output_tokens ?? 0,
        cost: d.session_cost ?? null,
      });
    }
    window.addEventListener("crew:cost", handler);
    return () => window.removeEventListener("crew:cost", handler);
  }, []);

  const parts: string[] = [];
  if (model) parts.push(model);
  if (cost.inputTokens || cost.outputTokens) {
    parts.push(
      `${cost.inputTokens.toLocaleString()} in / ${cost.outputTokens.toLocaleString()} out`,
    );
  }
  if (cost.cost != null) {
    parts.push(`$${cost.cost.toFixed(4)}`);
  }

  if (parts.length === 0 && !provider) return null;

  return (
    <div data-testid="cost-bar" className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 text-xs text-muted">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="mr-3 text-border">|</span>}
          {p}
        </span>
      ))}
    </div>
  );
}
