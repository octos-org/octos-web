import { Component, memo, useEffect, useRef, useState, type ReactNode, type ErrorInfo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Download } from "lucide-react";
import { MediaPlayer } from "./media-player";
import mermaid from "mermaid";
import DOMPurify from "dompurify";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "strict",
  fontFamily: "ui-monospace, monospace",
});

let mermaidCounter = 0;

function MermaidBlock({ content }: { content: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    const id = `mermaid-${++mermaidCounter}`;
    mermaid.render(id, content.trim())
      .then(({ svg }) => {
        setSvg(svg);
        // Clean up the temporary DOM element mermaid creates for rendering
        const el = document.getElementById(id);
        if (el) el.remove();
      })
      .catch(() => {});
  }, [content]);
  if (!svg) return <pre className="my-3 rounded-2xl bg-code-block-bg p-4 text-xs text-code-text whitespace-pre-wrap">{content}</pre>;
  return <div className="my-3 overflow-x-auto rounded-2xl bg-code-block-bg p-4" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) }} />;
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const lang = className?.replace("language-", "") || "";
  const codeText = typeof children === "string" ? children : "";

  if (lang === "mermaid") return <MermaidBlock content={codeText} />;

  return (
    <div className="group relative my-3">
      {lang && (
        <div className="flex items-center justify-between rounded-t-2xl bg-code-header-bg px-4 py-1.5 text-[10px] text-code-text/50">
          <span className="font-medium uppercase tracking-wider">{lang}</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(codeRef.current?.textContent || codeText);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="rounded-lg px-2 py-0.5 opacity-0 group-hover:opacity-100 text-code-text/50 hover:text-white hover:bg-white/10"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}
      <pre className={`overflow-x-auto ${lang ? "rounded-b-2xl" : "rounded-2xl"} bg-code-block-bg p-4 text-xs leading-relaxed text-code-text`}>
        <code ref={codeRef} className={className}>{children}</code>
      </pre>
    </div>
  );
}

class MarkdownErrorBoundary extends Component<{ children: ReactNode; fallback: string }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[markdown] render error:", error, info);
  }
  componentDidUpdate(prevProps: { fallback: string }) {
    // Reset error state when content changes (new message)
    if (prevProps.fallback !== this.props.fallback && this.state.error) {
      this.setState({ error: false });
    }
  }
  render() {
    if (this.state.error) {
      return <p className="whitespace-pre-wrap">{this.props.fallback}</p>;
    }
    return this.props.children;
  }
}

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

const mdComponents: Record<string, any> = {
  img: ({ src, alt }: any) => {
    if (!src) return null;
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="block my-2">
        <img src={src} alt={alt || "image"} className="max-w-full max-h-96 rounded-lg border border-border" loading="lazy" />
      </a>
    );
  },
  a: ({ href, children }: any) => {
    if (!href) return <>{children}</>;
    if (/\.(mp3|wav|ogg|webm|m4a|aac|flac)$/i.test(href))
      return <MediaPlayer src={href} type="audio" title={typeof children === "string" ? children : "audio"} />;
    if (/\.(mp4|webm|mov)$/i.test(href))
      return <MediaPlayer src={href} type="video" title={typeof children === "string" ? children : "video"} />;
    if (/\.(pdf|pptx|docx|xlsx|zip|tar|gz)$/i.test(href))
      return <a href={href} download className="inline-flex items-center gap-1 rounded-md bg-surface-light px-2 py-1 text-xs text-link hover:bg-accent/20 hover:text-accent"><Download size={12} />{children}</a>;
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-link hover:text-accent hover:underline">{children}</a>;
  },
  pre: ({ children }: any) => <>{children}</>,
  code: ({ children, className: cn, inline }: any) => {
    if (inline || (!cn && typeof children === "string" && !children.includes("\n"))) {
      return <code className="rounded bg-code-inline/15 px-1.5 py-0.5 text-xs text-code-inline">{children}</code>;
    }
    return <CodeBlock className={cn}>{children}</CodeBlock>;
  },
  table: ({ children }: any) => (
    <div className="my-3 overflow-x-auto rounded-2xl bg-surface-container"><table className="min-w-full text-xs">{children}</table></div>
  ),
  th: ({ children }: any) => <th className="border-b border-outline bg-surface-elevated px-4 py-2 text-left font-medium text-text-strong">{children}</th>,
  td: ({ children }: any) => <td className="border-b border-border px-4 py-2">{children}</td>,
  p: ({ children }: any) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }: any) => <ul className="mb-3 list-disc pl-5 space-y-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="mb-3 list-decimal pl-5 space-y-1">{children}</ol>,
  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }: any) => <h1 className="mb-3 mt-5 text-xl font-bold text-heading-accent border-b-2 border-accent-dim pb-1">{children}</h1>,
  h2: ({ children }: any) => <h2 className="mb-2 mt-4 text-lg font-bold text-heading">{children}</h2>,
  h3: ({ children }: any) => <h3 className="mb-2 mt-3 text-base font-semibold text-heading">{children}</h3>,
  h4: ({ children }: any) => <h4 className="mb-1 mt-2 text-sm font-semibold text-text-strong">{children}</h4>,
  blockquote: ({ children }: any) => (
    <blockquote className="my-3 border-l-3 border-blockquote-border pl-4 text-muted italic">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  strong: ({ children }: any) => <strong className="font-semibold text-text-strong">{children}</strong>,
  em: ({ children }: any) => <em className="italic">{children}</em>,
  del: ({ children }: any) => <del className="text-muted line-through">{children}</del>,
  // Task list checkboxes (GFM)
  input: ({ checked, ...props }: any) => (
    <input type="checkbox" checked={checked} readOnly className="mr-1.5 accent-accent" {...props} />
  ),
};

const MemoizedMarkdown = memo(function MemoizedMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Standalone markdown renderer — no assistant-ui dependency. */
export function MarkdownContent({ text, className }: { text: string; className?: string }) {
  return (
    <MarkdownErrorBoundary fallback={text}>
      <MemoizedMarkdown text={text} className={className} />
    </MarkdownErrorBoundary>
  );
}

/**
 * @deprecated Use MarkdownContent instead. Kept for backward compatibility
 * with any code that still imports RichMarkdown.
 */
export function RichMarkdown({ className, text }: { className?: string; text?: string }) {
  const content = text ?? "";
  return (
    <MarkdownErrorBoundary fallback={content}>
      <MemoizedMarkdown text={content} className={className} />
    </MarkdownErrorBoundary>
  );
}
