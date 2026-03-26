/**
 * Infographic generation UI — Issue #29
 */
import { useState } from "react";
import { Loader2, Wand2, RotateCcw } from "lucide-react";
import { NotebookMarkdown } from "./notebook-markdown";

const INFOGRAPHIC_STYLES = ["Cyberpunk", "Magazine", "Minimal", "Multi-section"] as const;

const STYLE_COLORS: Record<string, { bg: string; accent: string; card: string }> = {
  Cyberpunk: { bg: "bg-gradient-to-br from-purple-950 via-gray-900 to-cyan-950", accent: "border-cyan-400 text-cyan-300", card: "bg-gray-900/80 border-cyan-500/30" },
  Magazine: { bg: "bg-gradient-to-br from-amber-50 to-orange-50", accent: "border-orange-400 text-orange-700", card: "bg-white border-orange-200" },
  Minimal: { bg: "bg-surface", accent: "border-accent text-accent", card: "bg-surface-light border-border" },
  "Multi-section": { bg: "bg-surface", accent: "border-accent text-accent", card: "bg-surface-light border-border" },
};

interface Section {
  title: string;
  content: string;
}

function parseSections(text: string): Section[] {
  const parts = text.split(/\n(?=#{1,3}\s)/);
  return parts
    .map((p) => {
      const lines = p.trim().split("\n");
      const title = lines[0].replace(/^#{1,3}\s*/, "").trim();
      const content = lines.slice(1).join("\n").trim();
      return { title, content };
    })
    .filter((s) => s.title);
}

interface Props {
  notebookId: string;
  chatApi: (notebookId: string, message: string) => Promise<string>;
}

export function InfographicUI({ notebookId, chatApi }: Props) {
  const [style, setStyle] = useState<string>(INFOGRAPHIC_STYLES[0]);
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [rawResult, setRawResult] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setSections([]);
    setRawResult(null);
    try {
      const prompt = `Create a detailed infographic outline about the key points from sources. Style: ${style}. Format as sections with headers and data points.`;
      const content = await chatApi(notebookId, prompt);
      setRawResult(content);
      const parsed = parseSections(content);
      setSections(parsed.length >= 2 ? parsed : []);
    } catch {
      setRawResult("Generation failed.");
    } finally {
      setLoading(false);
    }
  };

  if (!rawResult && !loading) {
    return (
      <div className="p-4 space-y-5">
        <div>
          <label className="mb-2 block text-xs font-medium text-muted">风格</label>
          <div className="grid grid-cols-2 gap-2">
            {INFOGRAPHIC_STYLES.map((s) => (
              <button
                key={s}
                onClick={() => setStyle(s)}
                className={`rounded-lg border px-3 py-2 text-sm transition ${
                  style === s ? "border-accent bg-accent/15 text-accent" : "border-border text-text hover:border-accent/50"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <button onClick={generate} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90">
          <Wand2 size={14} /> 生成信息图
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <Loader2 size={24} className="animate-spin text-accent mb-3" />
        <p className="text-sm text-muted">Generating {style} infographic...</p>
      </div>
    );
  }

  const colors = STYLE_COLORS[style] || STYLE_COLORS.Minimal;

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between">
        <button onClick={() => { setRawResult(null); setSections([]); }} className="flex items-center gap-1 text-xs text-muted hover:text-accent">
          <RotateCcw size={12} /> 新建
        </button>
      </div>

      {sections.length >= 2 ? (
        <div className={`rounded-xl p-6 ${colors.bg}`}>
          <div className="grid gap-4 sm:grid-cols-2">
            {sections.map((sec, i) => (
              <div key={i} className={`rounded-lg border p-4 ${colors.card}`}>
                <h3 className={`mb-2 text-sm font-bold ${colors.accent.split(" ").pop()}`}>{sec.title}</h3>
                <NotebookMarkdown text={sec.content} className="text-xs" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface p-4">
          <NotebookMarkdown text={rawResult || ""} className="text-sm" />
        </div>
      )}
    </div>
  );
}
