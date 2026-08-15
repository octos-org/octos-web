import { useSession } from "@/runtime/session-context";

/**
 * Header cost strip. Shows only the model name by default — token
 * counts and cost move into the hover/aria detail so everyday chat
 * sessions stay quiet (2026-08 UI audit: 4-decimal cost and token
 * ladders are engineer-facing noise in the always-visible header).
 */
export function CostBar({
  model,
  provider,
}: {
  model?: string;
  provider?: string;
}) {
  const { currentSessionStats } = useSession();

  const displayModel = currentSessionStats?.model || model;
  const visible =
    displayModel && displayModel !== "none" ? displayModel : provider;
  if (!visible) return null;

  const detailParts: string[] = [];
  if (displayModel && displayModel !== "none") detailParts.push(displayModel);
  if (currentSessionStats?.inputTokens || currentSessionStats?.outputTokens) {
    detailParts.push(
      `${(currentSessionStats?.inputTokens ?? 0).toLocaleString()} in / ${(currentSessionStats?.outputTokens ?? 0).toLocaleString()} out`,
    );
  }
  if (currentSessionStats?.cost != null) {
    detailParts.push(`$${currentSessionStats.cost.toFixed(4)}`);
  }
  const detail = detailParts.join(" · ");

  return (
    <div
      data-testid="cost-bar"
      className="flex flex-wrap items-center gap-2 text-xs text-muted/80"
    >
      <span
        className="glass-pill rounded-[12px] px-3 py-1.5"
        title={detail}
        aria-label={detail}
      >
        {visible}
      </span>
    </div>
  );
}
