import { useState, useCallback } from "react";
import { useStudio } from "../context/studio-context";
import { GENERATION_TILES } from "../constants";
import type { TileConfig } from "../constants";
import type { GenerationOptions, StudioSource } from "../types";
import { GenerationTile } from "./generation-tile";
import { GenerationOptionsPanel } from "./generation-options";
import { OutputCard } from "./output-card";
import * as StreamManager from "@/runtime/stream-manager";
import { getToken } from "@/api/client";

const API_BASE = "/api";

function buildGenerationPrompt(
  tile: TileConfig,
  options: GenerationOptions,
  sources: StudioSource[],
): string {
  const sourceBlock = sources
    .map((s, i) => {
      let content = "";
      if (s.text) content = s.text;
      else if (s.content) content = s.content;
      else if (s.serverPath) content = `[File: ${s.serverPath}]`;
      else if (s.url) content = `[URL: ${s.url}]`;
      return `### Source ${i + 1}: "${s.title}"\n${content}`;
    })
    .join("\n\n");

  const optionLines = Object.entries(options)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const typeInstructions: Record<string, string> = {
    summary:
      "Write a comprehensive summary synthesizing all the provided sources. Output as well-structured markdown.",
    report:
      "Conduct deep research on the topic described in the sources. Use the deep_search tool to gather additional information, then produce a structured research report with citations.",
    podcast:
      "Create a podcast script based on the sources, then use voice_synthesize to generate the audio. Output both the script and the audio file.",
    slides:
      "Create a professional slide deck (PPTX) based on the sources. Structure it with a title slide, agenda, key content slides, and a conclusion.",
  };

  return `Generate a ${tile.label} from the following sources.

## Sources
${sourceBlock}

## Options
${optionLines}

## Instructions
${typeInstructions[tile.type] || `Generate a ${tile.label} based on the provided sources.`}

Important: Deliver any generated files using send_file so the user can download them.`;
}

export function StudioPanel() {
  const { project, selectedSources, addOutput, updateOutput } = useStudio();
  const [activeTile, setActiveTile] = useState<TileConfig | null>(null);

  const handleGenerate = useCallback(
    (options: GenerationOptions) => {
      if (!project || !activeTile) return;

      const genSessionId = `studio-gen-${project.id}-${Date.now()}`;
      const title = `${activeTile.label} — ${new Date().toLocaleTimeString()}`;

      addOutput({
        type: activeTile.type,
        title,
        status: "generating",
        generationSessionId: genSessionId,
        options,
      });

      const prompt = buildGenerationPrompt(activeTile, options, selectedSources);

      // Start the SSE stream for this generation
      StreamManager.startStream(genSessionId, prompt, []);

      // Subscribe to capture file events and completion
      StreamManager.subscribe(genSessionId, (streamEvt) => {
        const evt = streamEvt.raw as any;
        if (evt.type === "file") {
          const token = getToken();
          const fileUrl = `${API_BASE}/files/${encodeURIComponent(evt.path)}?token=${encodeURIComponent(token || "")}`;
          const outputs = project.outputs;
          const target = outputs.find((o) => o.generationSessionId === genSessionId);
          if (target) {
            updateOutput(target.id, {
              fileUrl,
              filePath: evt.path,
              filename: evt.filename,
            });
          }
        }
        if (evt.type === "done") {
          const outputs = project.outputs;
          const target = outputs.find((o) => o.generationSessionId === genSessionId);
          if (target) {
            updateOutput(target.id, {
              status: "complete",
              preview: typeof evt.content === "string" ? evt.content.slice(0, 200) : undefined,
            });
          }
        }
        if (evt.type === "error") {
          const outputs = project.outputs;
          const target = outputs.find((o) => o.generationSessionId === genSessionId);
          if (target) {
            updateOutput(target.id, {
              status: "error",
              error: evt.message || "Generation failed",
            });
          }
        }
      });

      setActiveTile(null);
    },
    [project, activeTile, selectedSources, addOutput, updateOutput],
  );

  const outputs = project?.outputs ?? [];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Tile grid */}
      <div className="px-5 pt-5">
        <h2 className="mb-3 text-sm font-medium text-text-strong">Create</h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {GENERATION_TILES.map((tile) => (
            <GenerationTile
              key={tile.type}
              config={tile}
              onClick={() => setActiveTile(tile)}
              disabled={selectedSources.length === 0 && tile.available}
            />
          ))}
        </div>
      </div>

      {/* Options panel */}
      {activeTile && (
        <div className="px-5 pt-4">
          <GenerationOptionsPanel
            config={activeTile}
            sourceCount={selectedSources.length}
            onGenerate={handleGenerate}
            onClose={() => setActiveTile(null)}
          />
        </div>
      )}

      {/* Output list */}
      {outputs.length > 0 && (
        <div className="px-5 pt-6 pb-5">
          <h2 className="mb-3 text-sm font-medium text-text-strong">Outputs</h2>
          <div className="flex flex-col gap-2.5">
            {outputs
              .slice()
              .reverse()
              .map((output) => (
                <OutputCard key={output.id} output={output} />
              ))}
          </div>
        </div>
      )}

      {outputs.length === 0 && !activeTile && (
        <div className="flex flex-1 items-center justify-center px-5">
          <p className="text-xs text-muted/50">
            Select sources and click a tile to generate content
          </p>
        </div>
      )}
    </div>
  );
}
