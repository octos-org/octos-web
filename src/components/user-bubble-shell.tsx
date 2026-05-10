/**
 * Shared visual shell for user-rooted message bubbles.
 *
 * Lives outside `chat-thread.tsx` so both the real `ThreadUserBubble`
 * (rendered from `Thread.userMsg`) and the M9-γ-4 `<GhostBubble>`
 * overlay (purely visual optimistic UI) hang the same layout and CSS
 * classes off a single source of truth.
 *
 * Why a shell rather than direct reuse of `ThreadUserBubble`?
 *   • A `<GhostBubble>` carries raw `File` objects (not-yet-uploaded
 *     attachments), while `<ThreadUserBubble>` carries `MessageFile`
 *     records (server-resolved paths). The two file-row renderings are
 *     different by necessity — a pending file has no `/api/files/...`
 *     URL yet.
 *   • All other markup (outer flex, `message-card-user` glass classes,
 *     timestamp footer) is identical. Putting it here means one place
 *     to evolve user-bubble styling, both surfaces in sync.
 *
 * Test ids (`data-testid`) and `data-*` hooks are caller-supplied so
 * harness specs can target the optimistic overlay or the canonical
 * bubble distinctly.
 */

import { type ReactNode } from "react";

export interface UserBubbleShellProps {
  /** Rendered inside the `message-card-user` text card. The shell
   *  hides the card entirely when this is empty/falsy (matches the
   *  legacy `ThreadUserBubble` behaviour: a file-only user message has
   *  no text card). */
  text: ReactNode | null;
  /** Optional file rows. Caller controls both the file-row content
   *  (real `<FileAttachment>` for persisted files vs. pending pills
   *  for raw `File` objects) and the wrapper spacing. The shell is
   *  agnostic about file shape. */
  files?: ReactNode | null;
  /** Footer text — usually a formatted timestamp. */
  footer: ReactNode;
  /** Slot for state badges (e.g. the GhostBubble's "send not confirmed"
   *  inline error). Rendered below the footer and inside the same
   *  flex column so the badge stays right-aligned with the bubble. */
  trailing?: ReactNode | null;
  /** `data-testid` on the outer container. Defaults to undefined so
   *  consumers that don't need a test hook don't pollute the DOM. */
  outerTestId?: string;
  /** `data-testid` on the text card. */
  textTestId?: string;
  /** Extra `data-*` attributes propagated onto the outer container —
   *  used by the GhostBubble to surface `data-ghost-state` and
   *  `data-client-message-id` for harness specs. */
  outerDataAttributes?: Record<string, string | undefined>;
  /** Extra `data-*` attributes propagated onto the text card — used by
   *  the canonical `ThreadUserBubble` to publish `data-thread-id`. */
  textDataAttributes?: Record<string, string | undefined>;
}

/** Outer flex + max-width column + text card + files + footer + trailing.
 *  Visual structure is byte-identical between the canonical user bubble
 *  and the optimistic ghost overlay. */
export function UserBubbleShell({
  text,
  files,
  footer,
  trailing,
  outerTestId,
  textTestId,
  outerDataAttributes,
  textDataAttributes,
}: UserBubbleShellProps) {
  const showText = text !== null && text !== undefined && text !== "";
  return (
    <div
      data-testid={outerTestId}
      {...spreadDataAttributes(outerDataAttributes)}
      className="flex justify-end px-4 py-3"
    >
      <div className="flex max-w-[74%] flex-col items-end">
        {showText && (
          <div
            data-testid={textTestId}
            {...spreadDataAttributes(textDataAttributes)}
            className="message-card message-card-user rounded-[14px] rounded-br-[4px] px-4 py-2.5 text-sm leading-relaxed text-text"
          >
            {text}
          </div>
        )}
        {files && (
          <div className={`${showText ? "mt-2" : ""} flex flex-wrap gap-2`}>
            {files}
          </div>
        )}
        <div className="mt-1.5 px-1 text-[10px] text-muted/50 select-none">
          {footer}
        </div>
        {trailing}
      </div>
    </div>
  );
}

/** Drop `undefined` entries before spreading; React would otherwise
 *  serialise them as the literal string "undefined" on the DOM node. */
function spreadDataAttributes(
  attrs: Record<string, string | undefined> | undefined,
): Record<string, string> {
  if (!attrs) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
