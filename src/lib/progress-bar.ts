/** `▰▰▰▰▱▱▱▱` fixed-width fraction bar (UPCR-2026-026 compaction UX —
 * shared with the indicator's tests). */
export function progressBar(frac: number, width: number): string {
  const clamped = Math.min(1, Math.max(0, frac));
  const filled = Math.min(width, Math.round(clamped * width));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}
