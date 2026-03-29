import { useState } from "react";
import { X, Sparkles } from "lucide-react";
import type { TileConfig } from "../constants";
import type { GenerationOptions as GenOpts } from "../types";

export function GenerationOptionsPanel({
  config,
  sourceCount,
  onGenerate,
  onClose,
}: {
  config: TileConfig;
  sourceCount: number;
  onGenerate: (options: GenOpts) => void;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<GenOpts>(() => {
    const defaults: GenOpts = { ...config.defaultOptions };
    for (const field of config.optionFields) {
      if (field.default && !(field.key in defaults)) {
        defaults[field.key] = field.default;
      }
    }
    return defaults;
  });

  const Icon = config.icon;

  return (
    <div className="animate-in slide-in-from-bottom rounded-2xl bg-surface-container p-5 elevation-2">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={config.color}>
            <Icon size={22} />
          </div>
          <div>
            <h3 className="text-sm font-medium text-text-strong">
              Generate {config.label}
            </h3>
            <p className="text-[11px] text-muted">
              {sourceCount} source{sourceCount !== 1 ? "s" : ""} selected
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-text"
        >
          <X size={16} />
        </button>
      </div>

      {/* Options */}
      <div className="mb-4 flex flex-col gap-3">
        {config.optionFields.map((field) => (
          <div key={field.key}>
            <label className="mb-1 block text-[11px] font-medium text-muted">
              {field.label}
            </label>
            {field.type === "select" && field.options ? (
              <div className="flex flex-wrap gap-1.5">
                {field.options.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() =>
                      setOptions((prev) => ({ ...prev, [field.key]: opt.value }))
                    }
                    className={`rounded-lg px-3 py-1.5 text-xs transition ${
                      String(options[field.key]) === opt.value
                        ? "bg-accent text-white"
                        : "bg-surface text-text hover:bg-surface-elevated"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : (
              <input
                value={String(options[field.key] ?? "")}
                onChange={(e) =>
                  setOptions((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
                className="w-full rounded-lg bg-surface px-3 py-2 text-xs text-text outline-none"
              />
            )}
          </div>
        ))}
      </div>

      {/* Generate button */}
      <button
        onClick={() => onGenerate(options)}
        disabled={sourceCount === 0}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30"
      >
        <Sparkles size={16} />
        Generate {config.label}
      </button>
      {sourceCount === 0 && (
        <p className="mt-2 text-center text-[10px] text-red-400">
          Select at least one source
        </p>
      )}
    </div>
  );
}
