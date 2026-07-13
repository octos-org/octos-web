export interface QuizQuestion {
  question: string;
  choices: string[];
  answer: string;
  explanation: string;
}

export interface ParsedQuiz { title: string; questions: QuizQuestion[] }
export interface Flashcard { front: string; back: string }
export interface ParsedFlashcards { title: string; cards: Flashcard[] }

export function parseQuizMarkdown(text: string): ParsedQuiz | null {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim() || "Quiz";
  const questions: QuizQuestion[] = [];
  let current: QuizQuestion | null = null;
  for (const line of lines) {
    const question = line.match(/^\s*\d+\.\s+(.+)$/);
    if (question) {
      if (current?.answer && current.explanation) questions.push(current);
      current = { question: question[1].trim(), choices: [], answer: "", explanation: "" };
      continue;
    }
    if (!current) continue;
    const choice = line.match(/^\s+-\s+(.+)$/);
    const answer = line.match(/^\s*Answer:\s*(.+)$/i);
    const explanation = line.match(/^\s*Explanation:\s*(.+)$/i);
    if (choice && !current.answer) current.choices.push(choice[1].trim());
    else if (answer) current.answer = answer[1].trim();
    else if (explanation) current.explanation = explanation[1].trim();
    else if (current.explanation && line.trim()) current.explanation += ` ${line.trim()}`;
  }
  if (current?.answer && current.explanation) questions.push(current);
  return questions.length > 0 ? { title, questions } : null;
}

export function parseFlashcardsMarkdown(text: string): ParsedFlashcards | null {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim() || "Flashcards";
  const cards: Flashcard[] = [];
  let front = "";
  for (const line of lines) {
    const frontMatch = line.match(/^\s*-\s+Front:\s*(.+)$/i);
    const backMatch = line.match(/^\s+Back:\s*(.+)$/i);
    if (frontMatch) front = frontMatch[1].trim();
    else if (backMatch && front) { cards.push({ front, back: backMatch[1].trim() }); front = ""; }
  }
  return cards.length > 0 ? { title, cards } : null;
}
