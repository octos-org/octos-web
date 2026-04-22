export function nextTopicForCommand(message: string): string | null | undefined {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const siteMatch = trimmed.match(/^\/new\s+site\s+(.+)$/i);
  if (siteMatch) {
    const preset = siteMatch[1]?.trim();
    return preset ? `site ${preset}` : undefined;
  }

  const slidesMatch = trimmed.match(/^\/new\s+slides\s+(.+)$/i);
  if (slidesMatch) {
    const slug = slidesMatch[1]?.trim();
    return slug ? `slides ${slug}` : undefined;
  }

  const switchMatch = trimmed.match(/^\/s\s+(.+)$/i);
  if (switchMatch) {
    const topic = switchMatch[1]?.trim();
    if (!topic) return undefined;
    if (topic === "default") return null;
    return topic;
  }

  if (/^\/back(?:\s|$)/i.test(trimmed)) {
    return null;
  }

  return undefined;
}
