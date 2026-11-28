type Section = { id: string; label: string; start: number };
export type ReadingText = { text: string; sections: Section[]; signature: string };
export type ReadingAnchor = ReturnType<typeof anchorSelection>;
export type ReadingAnnotation = { id: string; key: string; anchor: ReadingAnchor; note: string };
export type Resolution = { status: "matched"; start: number } | { status: "missing" } | { status: "ambiguous"; count: number };

export function textSignature(text: string) {
  // The offset is a fast path only for unchanged rendered text. Also verify the quote and context.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

export function anchorSelection(index: ReadingText, start: number, end: number) {
  let section: Section | undefined;
  for (const heading of index.sections) {
    if (heading.start > start) break;
    section = heading;
  }
  return {
    sectionId: section?.id ?? "", sectionLabel: section?.label ?? "",
    quote: index.text.slice(start, end), before: index.text.slice(Math.max(0, start - 48), start),
    after: index.text.slice(end, end + 48), start, signature: index.signature,
  };
}

export function resolveAnchor(index: ReadingText, anchor: ReadingAnchor): Resolution {
  const { text, sections } = index;
  const { quote, before, after } = anchor;
  if (!quote) return { status: "missing" };
  const section = sections.findIndex(item => item.id === anchor.sectionId && item.label === anchor.sectionLabel);
  const knownSection = !anchor.sectionId || section >= 0;
  const from = section >= 0 ? sections[section].start : 0;
  const until = knownSection ? sections[section + 1]?.start ?? text.length : text.length;
  const contextScore = (start: number) =>
    Number(Boolean(before.trim()) && text.slice(Math.max(0, start - before.length), start) === before)
    + Number(Boolean(after.trim()) && text.startsWith(after, start + quote.length));
  if (knownSection && index.signature === anchor.signature && anchor.start >= from && anchor.start < until
    && text.startsWith(quote, anchor.start) && contextScore(anchor.start) === Number(Boolean(before.trim())) + Number(Boolean(after.trim()))) {
    return { status: "matched", start: anchor.start };
  }
  // Identical headings receive ordinal IDs. After an edit, those ordinals may identify a different chapter.
  const sameHeadings = anchor.sectionId ? sections.filter(item => item.label === anchor.sectionLabel) : [];
  const ranges = sameHeadings.length > 1 ? sections.flatMap((item, i) => item.label === anchor.sectionLabel
    ? [{ from: item.start, until: sections[i + 1]?.start ?? text.length }] : []) : [{ from, until }];
  let best = -1, matched = -1, count = 0, candidates = 0;
  for (const scope of ranges) {
    for (let at = text.indexOf(quote, scope.from); at >= 0 && at < scope.until; at = text.indexOf(quote, at + 1)) {
      candidates++;
      const score = contextScore(at);
      if ((!knownSection && !score) || score < best) continue;
      if (score > best) { best = score; matched = at; count = 0; }
      count++;
    }
  }
  if (!count && candidates > 1) return { status: "ambiguous", count: candidates };
  if (count > 1) return { status: "ambiguous", count };
  return count ? { status: "matched", start: matched } : { status: "missing" };
}

const storageKey = "otterdive.reading-annotations.v1";

function validAnnotation(value: ReadingAnnotation) {
  const a = value?.anchor;
  return value && typeof value.id === "string" && typeof value.key === "string" && typeof value.note === "string"
    && a && [a.sectionId, a.sectionLabel, a.before, a.after, a.signature, a.quote].every(field => typeof field === "string")
    && a.quote.length > 0 && Number.isSafeInteger(a.start) && a.start >= 0;
}

export class AnnotationStore {
  private readonly storage: () => Pick<Storage, "getItem" | "setItem">;
  constructor(storage: () => Pick<Storage, "getItem" | "setItem">) { this.storage = storage; }

  private read(): ReadingAnnotation[] {
    const raw = this.storage().getItem(storageKey);
    if (raw === null) return [];
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || !entries.every(validAnnotation)) throw Error("本地阅读批注数据无法识别");
    return entries;
  }

  list(key: string) { return this.read().filter(entry => entry.key === key); }
  fileKeys() { return [...new Set(this.read().map(entry => entry.key).filter(key => key.startsWith("file:")))]; }

  put(item: ReadingAnnotation) {
    const entries = this.read();
    const at = entries.findIndex(entry => entry.id === item.id);
    if (at < 0) entries.push(item);
    else entries[at] = item;
    this.write(entries);
  }

  remove(id: string) { this.write(this.read().filter(entry => entry.id !== id)); }

  remap(mapper: (key: string) => string) {
    const entries = this.read();
    let changed = false;
    for (const entry of entries) {
      const key = mapper(entry.key);
      if (key !== entry.key) { entry.key = key; changed = true; }
    }
    if (changed) this.write(entries);
  }

  private write(entries: ReadingAnnotation[]) { this.storage().setItem(storageKey, JSON.stringify(entries)); }
}

export function locationLabel(resolution: Resolution) {
  if (resolution.status === "ambiguous") return `匹配到 ${resolution.count} 处`;
  return resolution.status === "missing" ? "原文失效" : "已定位";
}

function markdownLiteral(text: string) {
  return text.replace(/([\\`*_{}\[\]<>()#+!|~>=-])/g, "\\$1");
}

export function markdownExcerpts(title: string, items: Array<Pick<ReadingAnnotation, "anchor" | "note"> & { resolution: Resolution }>) {
  const lines = [`# ${markdownLiteral(title)} · 阅读摘录`, ""];
  for (const { anchor, note, resolution } of items) {
    lines.push(`## ${markdownLiteral(anchor.sectionLabel || "文档开头")}`, "", markdownLiteral(anchor.quote).replace(/^/gm, "> "), "");
    if (note) lines.push(`批注：${markdownLiteral(note)}`, "");
    if (resolution.status !== "matched") lines.push(`定位：${locationLabel(resolution)}`, "");
  }
  return lines.join("\n");
}
