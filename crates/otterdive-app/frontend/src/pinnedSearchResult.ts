export interface PinnedResultSource {
  readonly path: string | null;
  readonly fileName: string;
  readonly documentId?: number;
  readonly line: number;
  readonly column: number;
}

export interface PinnedResultInput {
  readonly kind: "search" | "search-analysis" | "analyse";
  readonly text: string;
  readonly sources: readonly PinnedResultSource[];
  readonly fields?: Readonly<Record<string, string>>;
  // Analyse owns its real payload, including style/Pattern data; it is not a SearchMatch.
  readonly analysis?: Readonly<{
    sourceLine: number;
    text: string;
    matchingPatternIds: readonly number[];
    styledSegments: readonly object[];
    sourceDocumentId?: number;
    sourceDocumentTitle?: string;
    sourceDocumentPath?: string | null;
  }>;
}
export interface PinnedResult extends PinnedResultInput {
  readonly id: string;
  readonly identity: string;
}
let nextPinnedResultId = 0;

function ownFrozenSnapshot<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(ownFrozenSnapshot)) as T;
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ownFrozenSnapshot(item)]))) as T;
  }
  return value;
}

/** Append immutable independent snapshots; repeated results never displace another pin. */
export function appendPinnedResults(previous: readonly PinnedResult[], inputs: readonly PinnedResultInput[]): readonly PinnedResult[] {
  const identities = new Set(previous.map(pin => pin.identity));
  const additions: PinnedResult[] = [];
  for (const input of inputs) {
    const identity = JSON.stringify(input);
    if (identities.has(identity)) continue;
    identities.add(identity);
    additions.push(Object.freeze({ ...ownFrozenSnapshot(input), identity, id: `pin-${++nextPinnedResultId}` }));
  }
  return additions.length ? Object.freeze([...previous, ...additions]) : previous;
}

export function removePinnedResult(previous: readonly PinnedResult[], id: string): readonly PinnedResult[] {
  return previous.some(pin => pin.id === id) ? Object.freeze(previous.filter(pin => pin.id !== id)) : previous;
}

/** Monaco ranges use an exclusive empty final line; collect overlapping/multiple ranges once. */
export function selectedResultLineIndices(
  selections: readonly { startLineNumber: number; endLineNumber: number; endColumn: number }[],
  count: number, currentLine: number, renderedLineCounts?: readonly number[],
): number[] {
  const indices = new Set<number>();
  const ranges = selections.length ? selections : [{ startLineNumber: currentLine, endLineNumber: currentLine, endColumn: 1 }];
  for (const range of ranges) {
    const end = range.endLineNumber - (range.endLineNumber > range.startLineNumber && range.endColumn === 1 ? 1 : 0);
    if (renderedLineCounts) {
      let start = 1;
      for (let index = 0; index < count; index++) {
        const last = start + Math.max(1, renderedLineCounts[index] ?? 1) - 1;
        if (last >= range.startLineNumber && start <= end) indices.add(index);
        start = last + 1;
      }
      continue;
    }
    for (let line = Math.max(1, range.startLineNumber); line <= Math.min(count, end); line++) indices.add(line - 1);
  }
  return [...indices].sort((a, b) => a - b);
}
