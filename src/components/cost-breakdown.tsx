/**
 * CostBreakdown — per-node cost panel for `run_pipeline` results.
 *
 * M8 runtime parity (W1.G4): the backend now returns a
 * `node_costs: NodeCost[]` array on every `PipelineResult` (see
 * `crates/octos-pipeline/src/executor.rs::PipelineResult`). Each row
 * captures the pre-dispatch reservation, the post-dispatch actual USD
 * derived from real token usage, and a `committed` flag that says
 * whether the row landed in the cost ledger. CostBreakdown surfaces
 * the full table plus an aggregate footer so the user can see where
 * tokens went without leaving the chat thread.
 *
 * The component is purely presentational — sorting + totals are
 * computed locally. A parent (chat-thread) attaches it under the
 * pipeline's `run_pipeline` tool-call pill once the
 * `tool_complete` SSE event fires with a body that contains a
 * `node_costs` array.
 */

import { useMemo, useState } from "react";

export interface NodeCost {
  node_id: string;
  model: string | null;
  reserved_usd: number;
  actual_usd: number;
  tokens_in: number;
  tokens_out: number;
  committed: boolean;
}

type SortKey =
  | "node_id"
  | "model"
  | "reserved_usd"
  | "actual_usd"
  | "tokens_in"
  | "tokens_out";

interface CostBreakdownProps {
  costs: NodeCost[];
  /** Optional contract id for the aggregate footer label. */
  contractId?: string;
  /** Hide the panel until at least this many rows are present. Default 1. */
  minRows?: number;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function compareKey(a: NodeCost, b: NodeCost, key: SortKey): number {
  switch (key) {
    case "node_id":
      return a.node_id.localeCompare(b.node_id);
    case "model":
      return (a.model ?? "").localeCompare(b.model ?? "");
    case "reserved_usd":
      return a.reserved_usd - b.reserved_usd;
    case "actual_usd":
      return a.actual_usd - b.actual_usd;
    case "tokens_in":
      return a.tokens_in - b.tokens_in;
    case "tokens_out":
      return a.tokens_out - b.tokens_out;
    default:
      return 0;
  }
}

export function CostBreakdown({
  costs,
  contractId,
  minRows = 1,
}: CostBreakdownProps) {
  const [sortKey, setSortKey] = useState<SortKey>("actual_usd");
  const [sortDesc, setSortDesc] = useState(true);

  const totals = useMemo(() => {
    let reserved = 0;
    let actual = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let committed = 0;
    for (const row of costs) {
      reserved += row.reserved_usd;
      actual += row.actual_usd;
      tokensIn += row.tokens_in;
      tokensOut += row.tokens_out;
      if (row.committed) committed += 1;
    }
    return { reserved, actual, tokensIn, tokensOut, committed };
  }, [costs]);

  const sorted = useMemo(() => {
    const copy = [...costs];
    copy.sort((a, b) => {
      const cmp = compareKey(a, b, sortKey);
      return sortDesc ? -cmp : cmp;
    });
    return copy;
  }, [costs, sortKey, sortDesc]);

  if (sorted.length < minRows) return null;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((v) => !v);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  return (
    <div
      data-testid="cost-breakdown"
      data-row-count={sorted.length}
      data-total-actual-usd={totals.actual.toFixed(6)}
      className="mt-2 flex flex-col rounded-[12px] border border-muted/15 bg-muted/5 p-2"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted">
          {contractId
            ? `Cost breakdown · ${contractId}`
            : "Cost breakdown · per node"}
        </span>
        <span className="font-mono text-[10px] text-muted/70">
          {sorted.length} {sorted.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <table
        data-testid="cost-breakdown-table"
        className="w-full font-mono text-[10px]"
      >
        <thead>
          <tr className="text-muted/70">
            <SortHeader
              testid="cost-breakdown-sort-node"
              label="node"
              active={sortKey === "node_id"}
              desc={sortDesc}
              onClick={() => handleSort("node_id")}
              align="left"
            />
            <SortHeader
              testid="cost-breakdown-sort-model"
              label="model"
              active={sortKey === "model"}
              desc={sortDesc}
              onClick={() => handleSort("model")}
              align="left"
            />
            <SortHeader
              testid="cost-breakdown-sort-tokens-in"
              label="in"
              active={sortKey === "tokens_in"}
              desc={sortDesc}
              onClick={() => handleSort("tokens_in")}
              align="right"
            />
            <SortHeader
              testid="cost-breakdown-sort-tokens-out"
              label="out"
              active={sortKey === "tokens_out"}
              desc={sortDesc}
              onClick={() => handleSort("tokens_out")}
              align="right"
            />
            <SortHeader
              testid="cost-breakdown-sort-reserved"
              label="reserved"
              active={sortKey === "reserved_usd"}
              desc={sortDesc}
              onClick={() => handleSort("reserved_usd")}
              align="right"
            />
            <SortHeader
              testid="cost-breakdown-sort-actual"
              label="actual"
              active={sortKey === "actual_usd"}
              desc={sortDesc}
              onClick={() => handleSort("actual_usd")}
              align="right"
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.node_id}
              data-testid="cost-breakdown-row"
              data-node-id={row.node_id}
              data-committed={row.committed ? "true" : "false"}
              className="text-text/90"
            >
              <td className="truncate py-0.5 pr-2">{row.node_id}</td>
              <td className="truncate py-0.5 pr-2 text-muted">
                {row.model ?? "default"}
              </td>
              <td className="py-0.5 pr-2 text-right">
                {fmtTokens(row.tokens_in)}
              </td>
              <td className="py-0.5 pr-2 text-right">
                {fmtTokens(row.tokens_out)}
              </td>
              <td className="py-0.5 pr-2 text-right text-muted">
                {fmtUsd(row.reserved_usd)}
              </td>
              <td className="py-0.5 text-right">
                <span
                  className={
                    row.committed
                      ? "text-emerald-400"
                      : "text-muted/70 italic"
                  }
                  title={row.committed ? "Committed to ledger" : "Refunded (auto-drop)"}
                >
                  {fmtUsd(row.actual_usd)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr
            data-testid="cost-breakdown-totals"
            className="border-t border-muted/15 text-text"
          >
            <td className="py-1 pr-2 font-semibold">TOTAL</td>
            <td className="py-1 pr-2 text-muted">
              {totals.committed} / {sorted.length} committed
            </td>
            <td className="py-1 pr-2 text-right">
              {fmtTokens(totals.tokensIn)}
            </td>
            <td className="py-1 pr-2 text-right">
              {fmtTokens(totals.tokensOut)}
            </td>
            <td className="py-1 pr-2 text-right text-muted">
              {fmtUsd(totals.reserved)}
            </td>
            <td className="py-1 text-right font-semibold">
              {fmtUsd(totals.actual)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

interface SortHeaderProps {
  testid: string;
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
  align: "left" | "right";
}

function SortHeader({
  testid,
  label,
  active,
  desc,
  onClick,
  align,
}: SortHeaderProps) {
  return (
    <th
      data-testid={testid}
      className={`cursor-pointer select-none py-0.5 pr-2 font-medium ${
        align === "right" ? "text-right" : "text-left"
      }`}
      onClick={onClick}
    >
      <span
        className={
          active ? "text-accent" : "text-muted/70 hover:text-accent"
        }
      >
        {label}
        {active ? (desc ? " ↓" : " ↑") : ""}
      </span>
    </th>
  );
}
