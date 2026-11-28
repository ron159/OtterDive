import { githubHeadingSlug } from "./markdownDecorations.ts";
import type { PageSource } from "./pagedDocument";

export interface MarkdownSection { title: string; level: number; anchor?: string; line: number; start: number; end: number }
export interface SectionIndex {
  sections: MarkdownSection[];
  definitions: { offset: number; text: string }[];
  sectionLimit: number;
}
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export function sectionMarkdown(text: string, section: MarkdownSection, index: SectionIndex) {
  const before = [], after = [];
  for (const definition of index.definitions) {
    if (definition.offset < section.start) before.push(definition.text);
    else if (definition.offset >= section.end) after.push(definition.text);
  }
  return [...before, text.replace(/^\uFEFF/, ""), ...after].join("\n\n");
}

// The reader belongs to the active tab only. Keep one rendered section, discard it on every
// navigation, and reject late IPC or lazy-renderer completions after cancellation or tab changes.
export class MarkdownSectionReader {
  index: SectionIndex | null = null;
  position = 0;
  readonly anchors = new Map<string, number>();
  status = "";
  busy = false;
  failed = false;
  private requestId: string | null = null;
  private generation = 0;
  readonly source: PageSource;
  private readonly invoke: Invoke;
  private readonly render: (source: string, current: () => boolean) => Promise<string>;
  private readonly update: (html?: string) => void;

  constructor(source: PageSource, invoke: Invoke, render: (source: string, current: () => boolean) => Promise<string>, update: (html?: string) => void) {
    this.source = source;
    this.invoke = invoke;
    this.render = render;
    this.update = update;
  }
  get location() {
    const section = this.index?.sections[this.position];
    return section ? `第 ${this.position + 1} / ${this.index!.sections.length} 节 · 源行 ${section.line}` : "";
  }
  private begin(message: string) {
    this.cancel();
    this.busy = true;
    this.failed = false;
    this.status = message;
    this.requestId = crypto.randomUUID();
    this.update("");
    return { generation: this.generation, request: { ...this.source, requestId: this.requestId } };
  }
  private fail(error: unknown, generation: number) {
    if (generation !== this.generation) return;
    this.busy = false;
    this.requestId = null;
    this.failed = true;
    this.status = error instanceof Error ? error.message : String(error);
    this.update("");
  }
  async open(sourceLine: number) {
    const { request, generation } = this.begin("正在扫描全文件章节…");
    try {
      const index = await this.invoke<SectionIndex>("index_markdown_sections", { request });
      if (generation !== this.generation) return;
      this.requestId = null;
      this.index = index;
      const suffixes = new Map<string, number>();
      for (const [i, section] of index.sections.entries()) {
        // Titles in the compact directory are limited to 96 codepoints. Avoid
        // guessing a fragment when a title may have been shortened.
        if (!section.level || [...section.title].length === 96) continue;
        const base = githubHeadingSlug(section.title) || "heading";
        let anchor = base;
        let suffix = suffixes.get(base) ?? 1;
        while (this.anchors.has(anchor)) anchor = `${base}-${suffix++}`;
        this.anchors.set(anchor, i);
        section.anchor = anchor;
        suffixes.set(base, suffix);
      }
      const next = index.sections.findIndex(section => section.line > sourceLine);
      await this.select(next < 0 ? index.sections.length - 1 : Math.max(0, next - 1));
    } catch (error) { this.fail(error, generation); }
  }
  async select(position: number) {
    const index = this.index;
    const section = index?.sections[position];
    if (!section || !index) return;
    this.position = position;
    const { request, generation } = this.begin("正在读取章节…");
    try {
      if (section.end - section.start > index.sectionLimit) throw new Error("本节超过 256 KiB 渲染上限，可切换其他章节或返回源码");
      const source = await this.invoke<string>("read_markdown_section", { request, start: section.start, end: section.end });
      if (generation !== this.generation) return;
      this.requestId = null;
      const html = await this.render(sectionMarkdown(source, section, index), () => generation === this.generation);
      if (generation !== this.generation) return;
      this.busy = false;
      this.status = this.location;
      this.update(html);
    } catch (error) { this.fail(error, generation); }
  }
  cancel() {
    this.generation++;
    if (this.requestId) void this.invoke("cancel_document_page", { requestId: this.requestId }).catch(() => {});
    this.requestId = null;
    this.busy = false;
  }
}

export function sectionOptions(sections: MarkdownSection[], position: number, query: string) {
  const term = query.trim().toLocaleLowerCase();
  const choices: number[] = [];
  // Limit the number of DOM options even when the file has thousands of headings.
  for (let i = term ? 0 : Math.max(0, position - 20); i < sections.length && choices.length < 41; i++) {
    if (!term || sections[i].title.toLocaleLowerCase().includes(term) || String(i + 1) === term) choices.push(i);
  }
  return choices;
}
