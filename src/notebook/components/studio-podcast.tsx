/**
 * Podcast script generation + audio player UI — Issues #32 & #34
 */
import { useState, useRef } from "react";
import { Loader2, Wand2, RotateCcw, Play, Pause, Volume2 } from "lucide-react";

const PODCAST_FORMATS = ["Deep Dive", "Brief", "Critique"] as const;

interface DialogueLine {
  speaker: string;
  text: string;
}

interface ScriptSection {
  title: string;
  lines: DialogueLine[];
}

function parseScript(text: string): { sections: ScriptSection[]; allLines: DialogueLine[] } {
  const allLines: DialogueLine[] = [];
  const sections: ScriptSection[] = [];
  let currentSection: ScriptSection = { title: "Introduction", lines: [] };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect section headers
    const headerMatch = trimmed.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      if (currentSection.lines.length > 0) {
        sections.push(currentSection);
      }
      currentSection = { title: headerMatch[1], lines: [] };
      continue;
    }

    // Detect dialogue: "Alex: ..." or "Sam: ..." or "**Alex**: ..."
    const dialogueMatch = trimmed.match(/^\*{0,2}(Alex|Sam|Host\s*\d*|Speaker\s*\d*)\*{0,2}\s*:\s*(.*)/i);
    if (dialogueMatch) {
      const dl: DialogueLine = { speaker: dialogueMatch[1], text: dialogueMatch[2] };
      allLines.push(dl);
      currentSection.lines.push(dl);
    }
  }
  if (currentSection.lines.length > 0) {
    sections.push(currentSection);
  }

  return { sections, allLines };
}

interface Props {
  notebookId: string;
  chatApi: (notebookId: string, message: string) => Promise<string>;
}

export function PodcastUI({ notebookId, chatApi }: Props) {
  const [format, setFormat] = useState<string>(PODCAST_FORMATS[0]);
  const [loading, setLoading] = useState(false);
  const [rawResult, setRawResult] = useState<string | null>(null);
  const [sections, setSections] = useState<ScriptSection[]>([]);
  const [allLines, setAllLines] = useState<DialogueLine[]>([]);

  // Mock player state (#34)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const [activeChapter, setActiveChapter] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const generate = async () => {
    setLoading(true);
    setRawResult(null);
    setSections([]);
    setAllLines([]);
    setProgress(0);
    setPlaying(false);
    try {
      const prompt = `Create a podcast script with two hosts (Alex and Sam) discussing the notebook sources. Format: ${format}. Write as dialogue: Alex: ... Sam: ...`;
      const content = await chatApi(notebookId, prompt);
      setRawResult(content);
      const parsed = parseScript(content);
      setSections(parsed.sections);
      setAllLines(parsed.allLines);
    } catch {
      setRawResult("Generation failed.");
    } finally {
      setLoading(false);
    }
  };

  const togglePlay = () => {
    if (playing) {
      if (timerRef.current) clearInterval(timerRef.current);
      setPlaying(false);
    } else {
      setPlaying(true);
      timerRef.current = setInterval(() => {
        setProgress((p) => {
          if (p >= 100) {
            if (timerRef.current) clearInterval(timerRef.current);
            setPlaying(false);
            return 100;
          }
          return p + 0.5 * speed;
        });
      }, 200);
    }
  };

  const mockDuration = allLines.length * 30; // ~30s per line
  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };
  const currentTime = (progress / 100) * mockDuration;

  if (!rawResult && !loading) {
    return (
      <div className="p-4 space-y-5">
        <div>
          <label className="mb-2 block text-xs font-medium text-muted">格式</label>
          <div className="flex gap-2">
            {PODCAST_FORMATS.map((f) => (
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
          <Wand2 size={14} /> 生成播客脚本
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <Loader2 size={24} className="animate-spin text-accent mb-3" />
        <p className="text-sm text-muted">Writing your {format} podcast...</p>
      </div>
    );
  }

  const speakerColor = (s: string) =>
    /alex/i.test(s) ? "text-cyan-400" : /sam/i.test(s) ? "text-amber-400" : "text-accent";

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between">
        <button onClick={() => { setRawResult(null); setSections([]); setAllLines([]); }} className="flex items-center gap-1 text-xs text-muted hover:text-accent">
          <RotateCcw size={12} /> 新建
        </button>
      </div>

      {/* Mock audio player (#34) */}
      <div className="rounded-lg border border-border bg-surface-light p-3 space-y-3">
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-surface-dark transition hover:bg-accent/80"
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <div
            className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-surface-dark"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setProgress(((e.clientX - rect.left) / rect.width) * 100);
            }}
          >
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
          <span className="text-xs tabular-nums text-muted">
            {formatTime(currentTime)} / {formatTime(mockDuration)}
          </span>
          <Volume2 size={14} className="text-muted" />
        </div>

        {/* Speed selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">速度：</span>
          {[0.5, 1, 1.5, 2].map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`rounded px-2 py-0.5 text-xs transition ${
                speed === s ? "bg-accent/15 text-accent" : "text-muted hover:text-text"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Chapter markers */}
        {sections.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sections.map((sec, i) => (
              <button
                key={i}
                onClick={() => {
                  setActiveChapter(i);
                  // Jump to approximate position
                  const totalLines = allLines.length || 1;
                  const linesBeforeThis = sections.slice(0, i).reduce((acc, s) => acc + s.lines.length, 0);
                  setProgress((linesBeforeThis / totalLines) * 100);
                }}
                className={`rounded px-2 py-0.5 text-xs transition ${
                  activeChapter === i ? "bg-accent/15 text-accent" : "text-muted hover:text-text"
                }`}
              >
                {sec.title}
              </button>
            ))}
          </div>
        )}

        <p className="text-[10px] text-muted italic">模拟播放器 — TTS 尚未接入</p>
      </div>

      {/* Script display (#32) */}
      <div className="space-y-4">
        {sections.length > 0 ? (
          sections.map((sec, si) => (
            <div key={si}>
              <h3 className="mb-2 text-sm font-semibold text-text-strong">{sec.title}</h3>
              <div className="space-y-2">
                {sec.lines.map((line, li) => (
                  <div key={li} className="flex gap-2">
                    <span className={`text-xs font-bold whitespace-nowrap ${speakerColor(line.speaker)}`}>
                      {line.speaker}:
                    </span>
                    <span className="text-sm text-text">{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm whitespace-pre-wrap text-text">
            {rawResult}
          </div>
        )}
      </div>
    </div>
  );
}
