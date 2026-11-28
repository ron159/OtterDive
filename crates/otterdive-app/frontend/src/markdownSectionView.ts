import { MarkdownSectionReader, sectionOptions } from "./markdownSections";
import type { PageSource } from "./pagedDocument";

type DocumentSource = PageSource & { id: number };
interface ReaderHooks {
  invoke: ConstructorParameters<typeof MarkdownSectionReader>[1];
  source: () => DocumentSource | null;
  visibleLine: () => number;
  render: (source: string, current: () => boolean) => Promise<string>;
  resources: (root: HTMLElement) => void;
  sourceLine: (line: number) => void;
  openLink: (href: string) => void;
  layout: () => void;
}

export function bindMarkdownSectionView(hooks: ReaderHooks) {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const wrap = element("editorWrap");
  const body = element("pagedSectionBody");
  const button = element<HTMLButtonElement>("pagedSectionToggle");
  const previous = element<HTMLButtonElement>("pagedSectionPrevious");
  const next = element<HTMLButtonElement>("pagedSectionNext");
  const cancel = element<HTMLButtonElement>("pagedSectionCancel");
  const select = element<HTMLSelectElement>("pagedSectionSelect");
  const filter = element<HTMLInputElement>("pagedSectionFilter");
  const status = element("pagedSectionStatus");
  let reader: MarkdownSectionReader | null = null;
  let owner = 0;

  function choices() {
    const sections = reader?.index?.sections ?? [];
    const position = reader?.position ?? 0;
    select.replaceChildren(...sectionOptions(sections, position, filter.value).map(i => {
      const section = sections[i];
      return new Option(`${i + 1}. ${section.title}（行 ${section.line}）`, String(i));
    }));
    // Selecting the first (and possibly only) filtered result must fire a change.
    select.value = String(position);
  }
  function update(html: string = "") {
    if (!reader) return;
    const count = reader.index?.sections.length ?? 0;
    status.textContent = reader.failed ? reader.location : reader.status;
    cancel.disabled = !reader.busy;
    previous.disabled = !count || reader.position === 0;
    next.disabled = !count || reader.position + 1 >= count;
    filter.disabled = !count;
    select.disabled = !count;
    choices();
    body.innerHTML = html;
    if (reader.failed) {
      const reason = document.createElement("p");
      reason.setAttribute("role", "alert");
      reason.textContent = reader.status;
      const source = document.createElement("button");
      source.type = "button";
      source.textContent = "查看分块源码";
      source.addEventListener("click", () => button.click());
      body.replaceChildren(reason, source);
    } else if (html) {
      const section = reader.index?.sections[reader.position];
      if (section?.anchor) {
        const heading = body.querySelector<HTMLElement>(`.markdown-body > h${section.level}`);
        if (heading && !body.querySelector(`#${CSS.escape(section.anchor)}`)) heading.id = section.anchor;
      }
      hooks.resources(body);
      for (const toc of body.querySelectorAll(".markdown-toc")) {
        const jump = document.createElement("button");
        jump.type = "button";
        jump.textContent = "查阅全文件章节目录";
        jump.addEventListener("click", () => filter.focus());
        toc.replaceWith(jump);
      }
      if (body.querySelector("code:is(.language-mermaid,.language-vega-lite,.language-plantuml,.language-flowchart,.language-sequence)")) {
        status.textContent += " · 本视图以源码显示图表";
      }
    }
    body.parentElement!.scrollTop = 0;
  }
  function close() {
    if (!reader) return;
    reader.cancel();
    reader = null;
    owner = 0;
    body.replaceChildren();
    select.replaceChildren();
    filter.value = "";
    wrap.classList.remove("paged-section-open");
    button.textContent = "按章节阅读";
    button.setAttribute("aria-expanded", "false");
    hooks.layout();
  }
  function sync() {
    const doc = hooks.source();
    if (reader && (!doc || doc.id !== owner || doc.revision !== reader.source.revision
      || doc.encoding !== reader.source.encoding || doc.path !== reader.source.path)) close();
    button.hidden = !doc;
  }
  button.addEventListener("click", () => {
    if (reader) {
      const line = reader.index?.sections[reader.position]?.line;
      close();
      if (line) hooks.sourceLine(line);
      return;
    }
    const doc = hooks.source();
    if (!doc) return;
    const line = hooks.visibleLine();
    owner = doc.id;
    wrap.classList.add("paged-section-open");
    button.textContent = "返回源码";
    button.setAttribute("aria-expanded", "true");
    reader = new MarkdownSectionReader(doc, hooks.invoke, hooks.render, update);
    void reader.open(line);
    hooks.layout();
  });
  function go(i: number) { filter.value = ""; void reader?.select(i); }
  filter.addEventListener("input", choices);
  select.addEventListener("change", () => { if (select.value) go(Number(select.value)); });
  previous.addEventListener("click", () => { if (reader) go(reader.position - 1); });
  next.addEventListener("click", () => { if (reader) go(reader.position + 1); });
  cancel.addEventListener("click", () => {
    if (!reader) return;
    reader.cancel();
    reader.status = "读取已取消，可选择章节或返回源码";
    update();
  });
  body.addEventListener("click", event => {
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href")!;
    if (href.startsWith("#")) {
      let id: string;
      try { id = decodeURIComponent(href.slice(1)); } catch { id = href.slice(1); }
      const section = reader?.anchors.get(id);
      if (section !== undefined && section !== reader?.position && !anchor.closest(".footnotes,.footnote-ref")) {
        go(section);
        return;
      }
      const target = body.querySelector<HTMLElement>(`#${CSS.escape(id) || "__empty_anchor__"}`);
      if (target) target.scrollIntoView({ block: "center" });
      else status.textContent = "锚点位于本节之外或不存在，请使用章节目录或全文搜索定位";
    } else hooks.openLink(href);
  });
  return { sync, close, get active() { return reader !== null; } };
}
