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
