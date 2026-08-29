export interface SearchResultHistoryEntry<TReport, TScope extends string = string> {
  id: number;
  query: string;
  scope: TScope;
  report: TReport;
  expanded: boolean;
}

export function addSearchResultHistory<TReport, TScope extends string>(
  entries: SearchResultHistoryEntry<TReport, TScope>[],
  query: string,
  scope: TScope,
  report: TReport,
) {
  const id = entries.reduce((highest, entry) => Math.max(highest, entry.id), 0) + 1;
  return [
    ...entries.map((entry) => ({ ...entry, expanded: false })),
    { id, query, scope, report, expanded: true },
  ];
}

export function toggleSearchResultHistory<TReport, TScope extends string>(
  entries: SearchResultHistoryEntry<TReport, TScope>[],
  id: number,
) {
  return entries.map((entry) => entry.id === id ? { ...entry, expanded: !entry.expanded } : entry);
}
