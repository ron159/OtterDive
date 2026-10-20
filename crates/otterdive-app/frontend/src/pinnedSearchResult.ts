export interface PinnedSearchResult {
  readonly path: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/** Own a snapshot, never a mutable result index or a reference to a search batch. */
export function pinSearchResultSnapshot(
  previous: PinnedSearchResult | null,
  row: PinnedSearchResult,
): PinnedSearchResult {
  if (previous && previous.path === row.path && previous.fileName === row.fileName
    && previous.line === row.line && previous.column === row.column && previous.text === row.text) {
    return previous;
  }
  return Object.freeze({ path: row.path, fileName: row.fileName, line: row.line, column: row.column, text: row.text });
}
