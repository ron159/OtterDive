export type HeadingLink = { id: string; text: string };

/** Only complete the destination currently being typed, never an arbitrary Markdown word. */
export function markdownLinkCompletionContext(beforeCursor: string) {
  const match = /(?:!?\[[^\]\r\n]*\]\(|^\s{0,3}\[[^\]\r\n]+\]:\s*)(<?)([^)>\r\n]*)$/.exec(beforeCursor);
  if (!match || /\s+["']/.test(match[2])) return null;
  return { value: match[2], start: beforeCursor.length - match[2].length };
}

export function headingLinkSuggestions(value: string, headings: readonly HeadingLink[]) {
  const hash = value.indexOf("#");
  if (hash < 0) return [];
  const prefix = value.slice(0, hash + 1);
  let query = value.slice(hash + 1);
  try { query = decodeURIComponent(query); } catch { /* Keep incomplete percent escapes while typing. */ }
  const needle = query.toLocaleLowerCase();
  return headings.filter(heading => heading.id.toLocaleLowerCase().includes(needle)
    || heading.text.toLocaleLowerCase().includes(needle)).slice(0, 200)
    .map(heading => ({ label: heading.text || heading.id, text: `${prefix}${encodeURIComponent(heading.id)}`, detail: `#${heading.id}` }));
}
