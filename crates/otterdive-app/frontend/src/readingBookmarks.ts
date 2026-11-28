export type ReadingBookmark = { anchor: string; name: string };
export type ReadingBookmarks = Record<string, ReadingBookmark[]>;

export function normalizeReadingBookmarks(value: unknown): ReadingBookmarks {
  const result: ReadingBookmarks = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, entries] of Object.entries(value)) {
    if (!/^(file|draft):./.test(key) || !Array.isArray(entries)) continue;
    const seen = new Set<string>();
    for (const item of entries) {
      if (typeof item?.anchor !== "string" || !item.anchor || seen.has(item.anchor)
        || typeof item.name !== "string" || !item.name.trim()) continue;
      (result[key] ??= []).push({ anchor: item.anchor, name: item.name.trim() });
      seen.add(item.anchor);
    }
  }
  return result;
}

export function moveReadingBookmarks(store: ReadingBookmarks, from: string, to: string, keepSource = false) {
  if (from === to || !store[from]) return;
  store[to] = store[from].map(bookmark => ({ ...bookmark }));
  if (!keepSource) delete store[from];
}
