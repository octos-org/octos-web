export interface CsvParseLimits {
  maxRows: number;
  maxCells: number;
}

export interface CsvParseResult {
  rows: string[][];
  overflow: boolean;
}

export function parseCsv(text: string): string[][];
export function parseCsv(text: string, limits: CsvParseLimits): CsvParseResult;
export function parseCsv(
  text: string,
  limits?: CsvParseLimits,
): string[][] | CsvParseResult {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellCount = 0;
  const finish = (overflow: boolean): string[][] | CsvParseResult => (
    limits ? { rows, overflow } : rows
  );
  const pushCell = (): boolean => {
    if (limits && cellCount >= limits.maxCells) return false;
    row.push(cell);
    cell = "";
    cellCount += 1;
    return true;
  };
  const pushRow = (): boolean => {
    if (!pushCell()) return false;
    if (limits && rows.length >= limits.maxRows) return false;
    rows.push(row);
    row = [];
    return true;
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ",") {
      if (!pushCell()) return finish(true);
    }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      if (!pushRow()) return finish(true);
    } else cell += char;
  }
  if (cell.length > 0 || row.length > 0 || input.endsWith(",")) {
    if (!pushRow()) return finish(true);
  }
  return finish(false);
}
