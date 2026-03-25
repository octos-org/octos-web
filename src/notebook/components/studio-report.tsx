/**
 * Report generation UI — Issue #30
 */
import { useState } from "react";
import { Loader2, Wand2, Download, RotateCcw } from "lucide-react";
import { NotebookMarkdown } from "./notebook-markdown";

const FORMATS = ["Summary Report", "Detailed Analysis", "Data Table"] as const;

const FORMAT_PROMPTS: Record<string, string> = {
  "Summary Report": "Generate a concise summary report of the key findings from the notebook sources. Include an executive summary, main points, and conclusions.",
  "Detailed Analysis": "Generate a detailed analytical report from the notebook sources. Include methodology, findings, analysis sections, and recommendations.",
  "Data Table": "Generate a structured data table report from the notebook sources. Present findings as organized tables with key metrics and comparisons.",
};

interface Props {
  notebookId: string;
  chatApi: (notebookId: string, message: string) => Promise<string>;
}

export function ReportUI({ notebookId, chatApi }: Props) {
  const [format, setFormat] = useState<string>(FORMATS[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setResult(null);
    try {
      const content = await chatApi(notebookId, FORMAT_PROMPTS[format] || FORMAT_PROMPTS["Summary Report"]);
      setResult(content);
    } catch {
      setResult("Generation failed.");
    } finally {
      setLoading(false);
    }
  };

  if (!result && !loading) {
    return (
      <div className="p-4 space-y-5">
        <div>
          <label className="mb-2 block text-xs font-medium text-muted">Format</label>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`rounded-lg border px-3 py-2 text-sm transition ${
                  format === f ? "border-accent bg-accent/15 text-accent" : "border-border text-text hover:border-accent/50"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <button onClick={generate} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90">
          <Wand2 size={14} /> Generate Report
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <Loader2 size={24} className="animate-spin text-accent mb-3" />
        <p className="text-sm text-muted">Generating {format}...</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={() => setResult(null)} className="flex items-center gap-1 text-xs text-muted hover:text-accent">
          <RotateCcw size={12} /> New
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => alert("Word download is a mock — backend TBD")}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:border-accent/50 transition"
          >
            <Download size={14} /> Download as Word
          </button>
          <button
            onClick={() => alert("Excel download is a mock — backend TBD")}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:border-accent/50 transition"
          >
            <Download size={14} /> Download as Excel
          </button>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-surface p-4">
        <NotebookMarkdown text={result || ""} className="text-sm" />
      </div>
    </div>
  );
}
