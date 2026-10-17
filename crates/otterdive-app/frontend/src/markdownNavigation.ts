export type MarkdownCursor = {
  anchor: { line: number; ch: number } | null;
  focus: { line: number; ch: number } | null;
};

export type SourceSelection = {
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;
};

export function sourceSelectionToMarkdownCursor(selection: SourceSelection | null): MarkdownCursor | null {
  if (!selection) return null;
  return {
    anchor: { line: Math.max(0, selection.selectionStartLineNumber - 1), ch: Math.max(0, selection.selectionStartColumn - 1) },
    focus: { line: Math.max(0, selection.positionLineNumber - 1), ch: Math.max(0, selection.positionColumn - 1) },
  };
}

export function markdownCursorToSourceSelection(cursor: MarkdownCursor | null): SourceSelection | null {
  if (!cursor?.anchor || !cursor.focus) return null;
  return {
    selectionStartLineNumber: Math.max(1, cursor.anchor.line + 1), selectionStartColumn: Math.max(1, cursor.anchor.ch + 1),
    positionLineNumber: Math.max(1, cursor.focus.line + 1), positionColumn: Math.max(1, cursor.focus.ch + 1),
  };
}

export type MarkdownScrollAnchor = { headingIndex: number; offsetPx: number; fraction: number; sectionFraction?: number };

export type MarkdownDocumentLocation = {
  mode: "wysiwyg" | "source" | "split" | "reading";
  line: number;
  column: number;
  cursor: MarkdownCursor | null;
  scroll: MarkdownScrollAnchor;
};
export type MarkdownHistoryEntry = { key: string; path?: string | null; location: MarkdownDocumentLocation };

export function normalizeMarkdownLocations(value: unknown): Record<string, MarkdownDocumentLocation> {
  const result: Record<string, MarkdownDocumentLocation> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const finite = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number);
  const point = (raw: unknown) => {
    const p = raw as { line?: unknown; ch?: unknown } | null;
    return p && finite(p.line) && finite(p.ch) && p.line >= 0 && p.ch >= 0
      ? { line: Math.floor(p.line), ch: Math.floor(p.ch) } : null;
  };
  for (const [key, raw] of Object.entries(value).slice(-200)) {
    if (!raw || typeof raw !== "object" || key === "__proto__" || key.length > 4096) continue;
    const location = raw as MarkdownDocumentLocation;
    const s = location.scroll;
    if (!["wysiwyg", "source", "split", "reading"].includes(location.mode)
      || !finite(location.line) || location.line < 1 || !finite(location.column) || location.column < 1
      || !s || !finite(s.headingIndex) || !finite(s.offsetPx) || !finite(s.fraction)) continue;
    result[key] = {
      mode: location.mode, line: Math.floor(location.line), column: Math.floor(location.column),
      cursor: location.cursor ? { anchor: point(location.cursor.anchor), focus: point(location.cursor.focus) } : null,
      scroll: { headingIndex: Math.max(-1, Math.floor(s.headingIndex)), offsetPx: Math.max(0, s.offsetPx),
        fraction: Math.max(0, Math.min(1, s.fraction)),
        ...(finite(s.sectionFraction) ? { sectionFraction: Math.max(0, Math.min(1, s.sectionFraction)) } : {}) },
    };
  }
  return result;
}

export class MarkdownHistory {
  private past: MarkdownHistoryEntry[] = [];
  private future: MarkdownHistoryEntry[] = [];
  constructor(private readonly limit = 100) {}
  get canBack() { return this.past.length > 0; }
  get canForward() { return this.future.length > 0; }
  record(entry: MarkdownHistoryEntry) {
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  back(current: MarkdownHistoryEntry) {
    const target = this.past.pop();
    if (!target) return null;
    this.future.push(current);
    return target;
  }
  forward(current: MarkdownHistoryEntry) {
    const target = this.future.pop();
    if (!target) return null;
    this.past.push(current);
    return target;
  }
  snapshot() { return { past: [...this.past], future: [...this.future] }; }
  restore(snapshot: ReturnType<MarkdownHistory["snapshot"]>) {
    this.past = [...snapshot.past]; this.future = [...snapshot.future];
  }
  remap(mapper: (entry: MarkdownHistoryEntry) => MarkdownHistoryEntry) {
    this.past = this.past.map(mapper); this.future = this.future.map(mapper);
  }
}

export function captureMarkdownScrollAnchor(scrollTop: number, maximum: number, headings: number[]): MarkdownScrollAnchor {
  const top = Math.min(Math.max(0, maximum), Math.max(0, scrollTop));
  let headingIndex = -1;
  for (let index = 0; index < headings.length; index += 1) {
    if (headings[index] > top + 1) break;
    headingIndex = index;
  }
  const start = headingIndex < 0 ? 0 : headings[headingIndex];
  const end = headings[headingIndex + 1] ?? maximum;
  return {
    headingIndex, offsetPx: top - start, fraction: top / Math.max(1, maximum),
    sectionFraction: Math.min(1, Math.max(0, (top - start) / Math.max(1, end - start))),
  };
}

export function restoreMarkdownScrollAnchor(anchor: MarkdownScrollAnchor, maximum: number, headings: number[]) {
  if (!headings.length || anchor.headingIndex >= headings.length) return Math.max(0, maximum * anchor.fraction);
  const start = anchor.headingIndex < 0 ? 0 : headings[anchor.headingIndex];
  const end = headings[anchor.headingIndex + 1] ?? maximum;
  const offset = anchor.sectionFraction === undefined ? anchor.offsetPx : (end - start) * anchor.sectionFraction;
  return Math.min(Math.max(0, maximum), Math.max(0, start + offset));
}
