/**
 * Comic generation UI — Issue #31
 */
import { useState } from "react";
import { Loader2, Wand2, RotateCcw } from "lucide-react";

const COMIC_STYLES = ["xkcd", "manga", "pop-art", "snoopy"] as const;
const PANEL_COUNTS = [4, 6, 8] as const;

interface ComicPanel {
  number: number;
  scene: string;
  dialogue: string;
}

function parsePanels(text: string): ComicPanel[] {
  const panels: ComicPanel[] = [];
  // Match "Panel N:" patterns
  const regex = /Panel\s*(\d+)\s*:\s*\[([^\]]*)\]\s*(?:Character|Speaker|Narrator)?\s*:?\s*['"]?([\s\S]*?)(?=Panel\s*\d+\s*:|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    panels.push({
      number: parseInt(match[1], 10),
      scene: match[2].trim(),
      dialogue: match[3].trim().replace(/['"]+$/g, "").trim(),
    });
  }

  // Fallback: try splitting by numbered lines
  if (panels.length < 2) {
    const lines = text.split(/\n+/);
    let current: Partial<ComicPanel> | null = null;
    let num = 0;
    for (const line of lines) {
      const panelMatch = line.match(/^(?:#{1,3}\s*)?Panel\s*(\d+)/i) || line.match(/^(\d+)\.\s/);
      if (panelMatch) {
        if (current?.scene) panels.push(current as ComicPanel);
        num = parseInt(panelMatch[1], 10);
        current = { number: num, scene: line.replace(/^.*?:\s*/, "").trim(), dialogue: "" };
      } else if (current && line.trim()) {
        if (line.includes(":") && !current.dialogue) {
          current.dialogue = line.replace(/^.*?:\s*/, "").replace(/['"]/g, "").trim();
        } else if (current.dialogue) {
          current.dialogue += " " + line.trim();
        } else {
          current.scene += " " + line.trim();
        }
      }
    }
    if (current?.scene) panels.push(current as ComicPanel);
  }

  return panels;
}

const STYLE_THEMES: Record<string, { bg: string; border: string; font: string; bubble: string }> = {
  xkcd: { bg: "bg-white", border: "border-gray-800 border-2", font: "font-mono text-gray-800", bubble: "bg-white border-gray-800 border rounded-xl" },
  manga: { bg: "bg-gray-100", border: "border-black border-[3px]", font: "font-bold text-black", bubble: "bg-white border-black border-2 rounded-full" },
  "pop-art": { bg: "bg-yellow-100", border: "border-red-600 border-[3px]", font: "font-black text-red-700 uppercase", bubble: "bg-yellow-200 border-red-600 border-2 rounded-2xl" },
  snoopy: { bg: "bg-sky-50", border: "border-gray-700 border-2", font: "font-serif text-gray-700", bubble: "bg-white border-gray-600 border rounded-2xl" },
};

interface Props {
  notebookId: string;
  chatApi: (notebookId: string, message: string) => Promise<string>;
}

export function ComicUI({ notebookId, chatApi }: Props) {
  const [style, setStyle] = useState<string>(COMIC_STYLES[0]);
  const [panelCount, setPanelCount] = useState<number>(PANEL_COUNTS[0]);
  const [loading, setLoading] = useState(false);
  const [panels, setPanels] = useState<ComicPanel[]>([]);
  const [rawResult, setRawResult] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setPanels([]);
    setRawResult(null);
    try {
      const prompt = `Create a ${panelCount}-panel comic script explaining the key concepts. Style: ${style}. Format each panel as: Panel N: [Scene description] Character: 'Dialogue'`;
      const content = await chatApi(notebookId, prompt);
      setRawResult(content);
      setPanels(parsePanels(content));
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
            {COMIC_STYLES.map((s) => (
              <button
                key={s}
                onClick={() => setStyle(s)}
                className={`rounded-lg border px-3 py-2 text-sm capitalize transition ${
                  style === s ? "border-accent bg-accent/15 text-accent" : "border-border text-text hover:border-accent/50"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-2 block text-xs font-medium text-muted">格数</label>
          <div className="flex gap-2">
            {PANEL_COUNTS.map((n) => (
              <button
                key={n}
                onClick={() => setPanelCount(n)}
                className={`rounded-lg border px-4 py-2 text-sm transition ${
                  panelCount === n ? "border-accent bg-accent/15 text-accent" : "border-border text-text hover:border-accent/50"
                }`}
              >
                {n} panels
              </button>
            ))}
          </div>
        </div>
        <button onClick={generate} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90">
          <Wand2 size={14} /> 生成漫画
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <Loader2 size={24} className="animate-spin text-accent mb-3" />
        <p className="text-sm text-muted">Drawing your {style} comic...</p>
      </div>
    );
  }

  const theme = STYLE_THEMES[style] || STYLE_THEMES.xkcd;
  const cols = panels.length <= 4 ? "grid-cols-2" : panels.length <= 6 ? "grid-cols-3" : "grid-cols-4";

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between">
        <button onClick={() => { setRawResult(null); setPanels([]); }} className="flex items-center gap-1 text-xs text-muted hover:text-accent">
          <RotateCcw size={12} /> 新建
        </button>
      </div>

      {panels.length >= 2 ? (
        <div className={`grid gap-3 ${cols}`}>
          {panels.map((panel, i) => (
            <div key={i} className={`flex flex-col rounded-lg p-3 ${theme.bg} ${theme.border}`}>
              <span className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${theme.font}`}>
                Panel {panel.number || i + 1}
              </span>
              <p className={`mb-2 flex-1 text-xs italic ${theme.font} opacity-70`}>
                [{panel.scene}]
              </p>
              {panel.dialogue && (
                <div className={`relative px-3 py-2 text-xs ${theme.bubble}`}>
                  <span className={theme.font}>{panel.dialogue}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm whitespace-pre-wrap text-text">
          {rawResult}
        </div>
      )}
    </div>
  );
}
