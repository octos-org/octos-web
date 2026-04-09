import { useSession } from "@/runtime/session-context";

export function CostBar({
  model,
  provider,
}: {
  model?: string;
  provider?: string;
}) {
  const { currentSessionStats } = useSession();

  const parts: string[] = [];
  const displayModel = currentSessionStats?.model || model;
  if (displayModel && displayModel !== "none") parts.push(displayModel);
  if (currentSessionStats?.inputTokens || currentSessionStats?.outputTokens) {
    parts.push(
      `${(currentSessionStats?.inputTokens ?? 0).toLocaleString()} in / ${(currentSessionStats?.outputTokens ?? 0).toLocaleString()} out`,
    );
  }
  if (currentSessionStats?.cost != null) {
    parts.push(`$${currentSessionStats.cost.toFixed(4)}`);
  }

  if (parts.length === 0 && !provider) return null;

  return (
    <div data-testid="cost-bar" className="flex items-center gap-4 bg-surface-dark px-5 py-2.5 text-xs text-muted/70">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="mr-4 text-muted/20">&middot;</span>}
          {p}
        </span>
      ))}
    </div>
  );
}
