import type { SitePreset } from "./types";

export function extractMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (part): part is { type?: string; text?: string } =>
            !!part && typeof part === "object",
        )
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text?.trim() || "")
        .filter(Boolean)
        .join("\n\n")
        .trim();
    }
  } catch {
    // Plain text message content.
  }
  return content.trim();
}

export function inferSitePreset(
  fallback: SitePreset | undefined,
  text: string,
  media: string[] = [],
): SitePreset {
  if (fallback) return fallback;

  const source = `${text} ${media.join(" ")}`.toLowerCase();
  if (
    /(lesson|course|tutorial|calculus|physics|math|learning|课程|教程|学习|数学|物理)/.test(
      source,
    )
  ) {
    return "learning";
  }
  if (/(next|nextjs|app router|saas|product|event|论坛|活动|产品)/.test(source)) {
    return "nextjs";
  }
  if (/(react|vite|tool|dashboard|prototype|组件|工具|原型|ui)/.test(source)) {
    return "react";
  }
  return "astro";
}
