import { Radio } from "lucide-react";
import type { Profile } from "./settings-api";

interface ChannelsTabProps {
  profile: Profile;
}

export function ChannelsTab({ profile }: ChannelsTabProps) {
  // Channels live inside profile.config.channels (not a separate API endpoint).
  // The shape is unknown[] in the API -- we display whatever we get.
  const channels = profile.config.channels ?? [];

  return (
    <div className="space-y-6">
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Radio size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">Channels</h3>
              <p className="text-xs text-muted">
                {channels.length > 0
                  ? `${channels.length} channel${channels.length === 1 ? "" : "s"} configured`
                  : "Communication channels for the agent"}
              </p>
            </div>
          </div>
        </div>

        {channels.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-10 text-center">
            <Radio size={32} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">No channels configured</p>
            <p className="mt-1 text-xs text-muted/60">
              Channels can be configured from the admin dashboard
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {channels.map((channel, idx) => {
              // channels is unknown[], best-effort render
              const ch = channel as Record<string, unknown>;
              const kind = typeof ch.kind === "string" ? ch.kind : "unknown";
              const name = typeof ch.name === "string" ? ch.name : kind;
              const enabled = typeof ch.enabled === "boolean" ? ch.enabled : true;
              return (
                <div
                  key={typeof ch.id === "string" ? ch.id : idx}
                  className="flex items-center gap-4 rounded-xl bg-surface-container/60 px-4 py-3.5 border border-transparent hover:border-border transition"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-dark/60 text-xs font-bold uppercase text-muted">
                    {kind.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-strong truncate">
                        {name}
                      </span>
                      <span className="shrink-0 rounded-md bg-surface-dark/60 px-1.5 py-0.5 text-[10px] font-medium text-muted uppercase tracking-wider">
                        {kind}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <span className={`text-xs font-medium ${enabled ? "text-green-400" : "text-muted/60"}`}>
                      {enabled ? "Active" : "Inactive"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
