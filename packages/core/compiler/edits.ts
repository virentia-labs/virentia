// Edits of one source text and the source map back to it. Unchanged text maps
// line by line; replacing or inserted text maps to where it stands in the
// original.

export interface SourceMap {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly order: number;
}

export class SourceEdits {
  readonly source: string;
  readonly #edits: Edit[] = [];

  constructor(source: string) {
    this.source = source;
  }

  get changed(): boolean {
    return this.#edits.length > 0;
  }

  /** Replace `source.slice(start, end)`. Replaced ranges must not overlap. */
  replace(start: number, end: number, text: string): void {
    this.#edits.push({ start, end, text, order: this.#edits.length });
  }

  /**
   * Insert before `position`: ahead of a replacement that starts there, in
   * the order of the calls among insertions at the same position.
   */
  insert(position: number, text: string): void {
    this.replace(position, position, text);
  }

  apply(file: string): { code: string; map: SourceMap } {
    const source = this.source;
    const edits = [...this.#edits].sort(
      (a, b) =>
        a.start - b.start ||
        Number(a.end !== a.start) - Number(b.end !== b.start) ||
        a.order - b.order,
    );
    const lineStarts = [0];
    for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1))
      lineStarts.push(index + 1);
    const locate = (offset: number): [line: number, column: number] => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (lineStarts[middle] <= offset) low = middle;
        else high = middle - 1;
      }
      return [low, offset - lineStarts[low]];
    };

    const mappings = new Mappings();
    const chunks: string[] = [];
    // Original text keeps its own positions; new text maps to `origin`.
    const emit = (text: string, origin: number, original: boolean) => {
      if (!text) return;
      chunks.push(text);
      let [line, column] = locate(origin);
      mappings.add(line, column);
      let lineStart = 0;
      for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
        mappings.newline();
        lineStart = index + 1;
        if (lineStart === text.length) break;
        if (original) {
          line++;
          column = 0;
        }
        mappings.add(line, column);
      }
      mappings.advance(text.length - lineStart);
    };
    let cursor = 0;
    for (const edit of edits) {
      if (edit.start < cursor)
        throw new Error("[@virentia/core/compiler] Overlapping source edits");
      emit(source.slice(cursor, edit.start), cursor, true);
      emit(edit.text, edit.start, false);
      cursor = edit.end;
    }
    emit(source.slice(cursor), cursor, true);
    return {
      code: chunks.join(""),
      map: {
        version: 3,
        file,
        sources: [file],
        sourcesContent: [source],
        names: [],
        mappings: mappings.toString(),
      },
    };
  }
}

const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest) digit |= 32;
    out += base64[digit];
  } while (rest);
  return out;
}

/** Source map v3 mappings of one source: generated position → original line and column. */
class Mappings {
  readonly #lines: string[] = [];
  #segments: string[] = [];
  #column = 0;
  #lastColumn = -1;
  #previousColumn = 0;
  #previousLine = 0;
  #previousOriginalColumn = 0;

  add(line: number, column: number): void {
    // Text is never empty, so only an insertion's own start can repeat a column.
    if (this.#lastColumn === this.#column) return;
    this.#lastColumn = this.#column;
    this.#segments.push(
      vlq(this.#column - this.#previousColumn) +
        "A" +
        vlq(line - this.#previousLine) +
        vlq(column - this.#previousOriginalColumn),
    );
    this.#previousColumn = this.#column;
    this.#previousLine = line;
    this.#previousOriginalColumn = column;
  }

  advance(columns: number): void {
    this.#column += columns;
  }

  newline(): void {
    this.#lines.push(this.#segments.join(","));
    this.#segments = [];
    this.#column = 0;
    this.#lastColumn = -1;
    this.#previousColumn = 0;
  }

  toString(): string {
    return [...this.#lines, this.#segments.join(",")].join(";");
  }
}
