import type {
  BoardAction,
  LessonPacketV1,
  LessonSegment,
} from "./lesson-packet";

interface AssistantTurnForBoard {
  id: string;
  userText: string;
  assistantText: string;
}

export interface AssistantLessonPacketOptions {
  includeProblem?: boolean;
  origin?: { x: number; y: number };
  lessonTitle?: string;
}

interface ContentBlock {
  text: string;
  formulas: string[];
}

const MAX_SEGMENTS = 6;
const MAX_BLOCK_TEXT = 230;

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
  return compact(
    value
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^[-*+]\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/[“”]/g, ""),
  );
}

function truncate(value: string, limit: number): string {
  const text = compact(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function extractTitle(userText: string): string {
  const text = stripMarkdown(userText);
  const firstClause = text.split(/[。！？!?；;]/, 1)[0] || text;
  return truncate(firstClause, 34) || "本次问题";
}

function extractUserFormula(userText: string): string | null {
  const match =
    /\\\(([\s\S]+?)\\\)/.exec(userText) ??
    /\$\$([\s\S]+?)\$\$/.exec(userText) ??
    /\$([^$\n]+?)\$/.exec(userText);
  return match ? compact(match[1]) : null;
}

function extractBlocks(assistantText: string): ContentBlock[] {
  const normalized = assistantText
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .replace(/\s*[“"]?(第[一二三四五六七八九十\d]+步[：:])/g, "\n\n$1")
    .replace(/\s*(提示(?:一下)?[：:]?)/g, "\n\n$1")
    .trim();
  const paragraphs = normalized
    .split(/\n{2,}/)
    .flatMap((paragraph) => {
      if (paragraph.length <= MAX_BLOCK_TEXT) return [paragraph];
      const sentences = paragraph.split(/(?<=[。！？!?])\s*/).filter(Boolean);
      const chunks: string[] = [];
      for (const sentence of sentences) {
        const previous = chunks.at(-1);
        if (previous && previous.length + sentence.length <= MAX_BLOCK_TEXT) {
          chunks[chunks.length - 1] = `${previous}${sentence}`;
        } else {
          chunks.push(sentence);
        }
      }
      return chunks;
    })
    .filter((paragraph) => compact(paragraph).length > 0)
    .slice(0, MAX_SEGMENTS - 1);

  return paragraphs.map((paragraph) => {
    const formulas: string[] = [];
    const withoutFormulas = paragraph.replace(
      /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$/g,
      (_match, display: string, bracketed: string, inline: string) => {
        const formula = compact(display ?? bracketed ?? inline ?? "");
        if (formula && !formulas.includes(formula)) formulas.push(formula);
        return formula ? `〔式${formulas.indexOf(formula) + 1}〕` : " ";
      },
    );
    return {
      text: truncate(stripMarkdown(withoutFormulas), MAX_BLOCK_TEXT),
      formulas: formulas.slice(0, 4),
    };
  });
}

function estimatedTextHeight(text: string, large = false): number {
  const charsPerLine = large ? 25 : 31;
  const lineHeight = large ? 58 : 46;
  return Math.max(lineHeight, Math.ceil(text.length / charsPerLine) * lineHeight);
}

/**
 * Turn an ordinary tutoring reply into safe, declarative whiteboard actions.
 * This is the client-side guarantee for runtimes that cannot deliver a
 * `.octos-board.json` artifact; a richer artifact can replace it later.
 */
export function buildAssistantLessonPacket(
  turn: AssistantTurnForBoard,
  options: AssistantLessonPacketOptions = {},
): LessonPacketV1 | null {
  const assistantText = compact(turn.assistantText);
  if (!assistantText) return null;

  const problem = truncate(stripMarkdown(turn.userText), 260);
  const userFormula = extractUserFormula(turn.userText);
  const title =
    options.lessonTitle ??
    (userFormula ? `函数 ${userFormula}` : extractTitle(turn.userText));
  const segments: LessonSegment[] = [];
  const origin = options.origin ?? { x: 120, y: 80 };
  const includeProblem = options.includeProblem ?? true;

  if (includeProblem) {
    const problemActions: BoardAction[] = [
      {
        id: `${turn.id}-problem-label`,
        type: "write_text",
        text: "题目",
        at: origin,
        tone: "muted",
        size: "sm",
        semanticLevel: "topic",
      },
      userFormula
        ? {
            id: `${turn.id}-problem`,
            type: "write_formula",
            latex: userFormula,
            at: { x: origin.x, y: origin.y + 52 },
            tone: "accent",
            size: "xl",
            semanticLevel: "topic",
          }
        : {
            id: `${turn.id}-problem`,
            type: "write_text",
            text: problem || title,
            at: { x: origin.x, y: origin.y + 52 },
            tone: "ink",
            size: "lg",
            semanticLevel: "topic",
          },
      {
        id: `${turn.id}-problem-focus`,
        type: "focus",
        at: { x: origin.x + 320, y: origin.y + 180 },
        zoom: 0.82,
      },
    ];
    segments.push({
      id: `${turn.id}-problem-segment`,
      speech: "我先把题目写在白板上。",
      actions: problemActions,
    });
  }

  let x = origin.x;
  let y = includeProblem
    ? origin.y +
      132 +
      estimatedTextHeight(userFormula ?? problem ?? title, true) +
      70
    : origin.y;
  extractBlocks(turn.assistantText).forEach((block, index) => {
    const actions: BoardAction[] = [];
    const neededHeight =
      (block.text ? estimatedTextHeight(block.text) : 0) +
      block.formulas.length * 68 +
      54;
    if (y + neededHeight > 1040) {
      x += 760;
      y = 100;
    }

    if (!includeProblem && index === 0) {
      actions.push({
        id: `${turn.id}-continuation-focus`,
        type: "focus",
        at: { x: origin.x + 300, y: origin.y + 180 },
        zoom: 0.82,
      });
    }

    if (block.text) {
      const isStep = /^第[一二三四五六七八九十\d]+步/.test(block.text);
      actions.push({
        id: `${turn.id}-text-${index}`,
        type: "write_text",
        text: block.text,
        at: { x, y },
        tone: isStep ? "accent" : "ink",
        size: isStep ? "lg" : "md",
        semanticLevel: isStep ? "summary" : "detail",
      });
      y += estimatedTextHeight(block.text, isStep) + 20;
    }

    block.formulas.forEach((latex, formulaIndex) => {
      actions.push({
        id: `${turn.id}-formula-${index}-${formulaIndex}`,
        type: "write_formula",
        latex,
        at: { x: x + 34, y },
        tone: "accent",
        size: "lg",
        semanticLevel: "summary",
      });
      y += 68;
    });

    if (actions.length === 0) return;
    const speechSource = block.text || "我们看白板上的这个式子。";
    segments.push({
      id: `${turn.id}-explanation-${index}`,
      speech: truncate(speechSource, 88),
      actions,
    });
    y += 34;
  });

  return {
    version: 1,
    lessonId: `assistant-${turn.id}`,
    turnId: turn.id,
    title,
    segments,
  };
}
