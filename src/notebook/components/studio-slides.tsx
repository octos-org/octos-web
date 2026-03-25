/**
 * Slide Deck generation UI — Issues #24 & #25
 * Style selector, page count, generation, per-slide editing.
 */
import { useState } from "react";
import { Loader2, Wand2, Download, Edit3, X, RotateCcw } from "lucide-react";
import { NotebookMarkdown } from "./notebook-markdown";

const STYLES = ["Corporate", "Minimal", "Cyberpunk", "Chinese Traditional", "Academic", "Creative"] as const;
const PAGE_COUNTS = [8, 12, 16] as const;

interface SlideCard {
  title: string;
  body: string;
}

function parseSlides(text: string): SlideCard[] {
  // Try to split by "Slide N" or "## Slide" or numbered headers
  const slideRegex = /(?:^|\n)(?:#{1,3}\s*)?(?:Slide\s*(\d+)[:\s\-]*|(\d+)\.\s+)(.*?)(?=\n(?:#{1,3}\s*)?(?:Slide\s*\d+|(\d+)\.\s+)|\n*$)/gs;
  const slides: SlideCard[] = [];
  let match: RegExpExecArray | null;
  while ((match = slideRegex.exec(text)) !== null) {
    const title = (match[3] || "").trim();
    const bodyStart = match.index + match[0].length;
    slides.push({ title, body: "" });
  }

  // Fallback: split by double newline + heading pattern
  if (slides.length < 2) {
    const sections = text.split(/\n(?=#{1,3}\s)/);
    return sections.map((s) => {
      const lines = s.trim().split("\n");
      const title = lines[0].replace(/^#{1,3}\s*/, "").replace(/^Slide\s*\d+[:\s\-]*/i, "").trim();
      const body = lines.slice(1).join("\n").trim();
      return { title, body };
    }).filter((s) => s.title);
  }

  return slides;
}

interface Props {
  notebookId: string;
  chatApi: (notebookId: string, message: string) => Promise<string>;
}

export function SlidesUI({ notebookId, chatApi }: Props) {
  const [style, setStyle] = useState<string>(STYLES[0]);
  const [pageCount, setPageCount] = useState<number>(PAGE_COUNTS[1]);
  const [loading, setLoading] = useState(false);
  const [rawResult, setRawResult] = useState<string | null>(null);
  const [slides, setSlides] = useState<SlideCard[]>([]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editFeedback, setEditFeedback] = useState("");
  const [regeneratingIdx, setRegeneratingIdx] = useState<number | null>(null);

  const generate = async () => {
    setLoading(true);
    setRawResult(null);
    setSlides([]);
    try {
      const prompt = `Generate a ${pageCount}-page presentation about the notebook sources. Style: ${style}. Output a structured outline with slide titles and bullet points.`;
      const content = await chatApi(notebookId, prompt);
      setRawResult(content);
      const parsed = parseSlides(content);
      setSlides(parsed.length >= 2 ? parsed : []);
    } catch {
      setRawResult("Generation failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const regenerateSlide = async (idx: number) => {
    if (!slides[idx]) return;
    setRegeneratingIdx(idx);
    try {
      const prompt = `Regenerate slide ${idx + 1} of a presentation. Original slide title: "${slides[idx].title}". Original content: "${slides[idx].body}". User feedback: "${editFeedback}". Style: ${style}. Return only the updated slide content with title and bullet points.`;
      const content = await chatApi(notebookId, prompt);
      const updated = [...slides];
      const lines = content.trim().split("\n");
      updated[idx] = {
        title: lines[0].replace(/^#{1,3}\s*/, "").replace(/^Slide\s*\d+[:\s\-]*/i, "").trim(),
        body: lines.slice(1).join("\n").trim(),
      };
      setSlides(updated);
      setEditingIdx(null);
      setEditFeedback("");
    } catch {
      // ignore
    } finally {
      setRegeneratingIdx(null);
    }
  };

  // Config screen
  if (!rawResult && !loading) {
    return (
      <div className="p-4 space-y-5">
        <div>
          <label className="mb-2 block text-xs font-medium text-muted">Style</label>
          <div className="grid grid-cols-3 gap-2">
            {STYLES.map((s) => (
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
        <div>
          <label className="mb-2 block text-xs font-medium text-muted">Page Count</label>
          <div className="flex gap-2">
            {PAGE_COUNTS.map((n) => (
              <button
                key={n}
                onClick={() => setPageCount(n)}
                className={`rounded-lg border px-4 py-2 text-sm transition ${
                  pageCount === n ? "border-accent bg-accent/15 text-accent" : "border-border text-text hover:border-accent/50"
                }`}
              >
                {n} pages
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={generate}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90 transition"
        >
          <Wand2 size={14} /> Generate Slides
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <Loader2 size={24} className="animate-spin text-accent mb-3" />
        <p className="text-sm text-muted">Generating {pageCount}-page {style} slide deck...</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setRawResult(null); setSlides([]); }}
            className="flex items-center gap-1 text-xs text-muted hover:text-accent"
          >
            <RotateCcw size={12} /> New
          </button>
        </div>
        <button
          onClick={() => alert("PPTX download is a mock — backend TBD")}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:border-accent/50 transition"
        >
          <Download size={14} /> Download PPTX
        </button>
      </div>

      {/* Slide cards (#25) */}
      {slides.length >= 2 ? (
        <div className="space-y-3">
          {slides.map((slide, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-start justify-between mb-2">
                <span className="text-xs font-medium text-muted">Slide {i + 1}</span>
                <button
                  onClick={() => { setEditingIdx(editingIdx === i ? null : i); setEditFeedback(""); }}
                  className="rounded p-1 text-muted hover:text-accent"
                >
                  {editingIdx === i ? <X size={14} /> : <Edit3 size={14} />}
                </button>
              </div>
              <h3 className="text-sm font-semibold text-text-strong mb-1">{slide.title}</h3>
              <NotebookMarkdown text={slide.body} className="text-sm text-text" />
              {editingIdx === i && (
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <textarea
                    value={editFeedback}
                    onChange={(e) => setEditFeedback(e.target.value)}
                    placeholder="Describe how to improve this slide..."
                    rows={2}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none resize-none"
                  />
                  <button
                    onClick={() => regenerateSlide(i)}
                    disabled={!editFeedback.trim() || regeneratingIdx === i}
                    className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    {regeneratingIdx === i ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                    Regenerate this slide
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        /* Fallback: raw markdown */
        <div className="rounded-lg border border-border bg-surface p-4">
          <NotebookMarkdown text={rawResult || ""} className="text-sm" />
        </div>
      )}
    </div>
  );
}
