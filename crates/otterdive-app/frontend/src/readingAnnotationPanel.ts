import { AnnotationStore, locationLabel, markdownExcerpts, resolveAnchor, type ReadingAnchor, type ReadingAnnotation, type Resolution } from "./readingAnnotations";
import { clearReadingMarks, indexReadingBody, paintReadingSpans, revealReadingSpan, selectedAnchor } from "./readingAnnotationRanges";
import "./readingAnnotations.css";

type Entry = ReadingAnnotation & { resolution: Resolution };
type View = { key: string; title: string; body: HTMLElement; pane: HTMLElement; exportFile: (text: string) => Promise<void> };

function button(label: string, click: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.onclick = click;
  return element;
}

export class ReadingAnnotationPanel {
  private store = new AnnotationStore(() => window.localStorage);
  private view?: View;
  private entries: Entry[] = [];
  private replacement: ReadingAnchor | null = null;
  private marks: HTMLElement[] = [];
  private dialog?: HTMLDialogElement;
  private manager?: HTMLButtonElement;
  private events?: AbortController;
  private report: (error: unknown) => void;
  constructor(report: (error: unknown) => void) { this.report = report; }

  leave() {
    this.events?.abort();
    this.events = undefined;
    this.manager = undefined;
    this.close();
    this.view = undefined;
    this.marks = [];
    this.entries = [];
  }

  remap(mapper: (key: string) => string) {
    try { this.store.remap(mapper); }
    catch (error) { this.report(error); }
  }

  attach(view: View, header: HTMLElement) {
    if (this.view?.key !== view.key) this.leave();
    this.events?.abort();
    this.events = new AbortController();
    this.view = view;
    this.marks = [];
    const bar = document.createElement("section");
    bar.className = "reading-annotation-tools";
    bar.ariaLabel = "阅读批注工具";
    const highlight = button("高亮", () => this.add(false));
    const annotate = button("写批注", () => this.add(true));
    const updateSelection = () => {
      const range = this.selection();
      highlight.disabled = annotate.disabled = !range;
    };
    for (const tool of [highlight, annotate]) {
      tool.title = "先在正文中选择文字";
      tool.onmousedown = event => event.preventDefault();
    }
    document.addEventListener("selectionchange", updateSelection, { signal: this.events.signal });
    updateSelection();
    this.manager = button("批注列表", () => {
      const range = this.selection();
      this.replacement = range && selectedAnchor(view.body, range);
      this.list();
    });
    this.manager.onmousedown = event => event.preventDefault();
    bar.append(highlight, annotate, this.manager);
    header.append(bar);
    try {
      this.refresh();
      if (this.dialog?.ariaLabel === "阅读批注") this.list();
    } catch (error) { this.report(error); }
  }

  private selection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    return this.view?.body.contains(range.commonAncestorContainer) ? range : null;
  }

  private refresh() {
    const view = this.view!;
    const records = this.store.list(view.key);
    clearReadingMarks(this.marks);
    this.marks = [];
    this.entries = [];
    if (records.length) {
      const index = indexReadingBody(view.body);
      this.entries = records.map(item => ({ ...item, resolution: resolveAnchor(index, item.anchor) }));
      const spans = this.entries.flatMap(({ resolution, anchor }) => resolution.status === "matched"
        ? [{ start: resolution.start, end: resolution.start + anchor.quote.length }] : []);
      this.marks = paintReadingSpans(index, spans);
    }
    this.manager!.textContent = `批注列表 (${records.length})`;
  }

  private add(edit: boolean) {
    const range = this.selection();
    const anchor = range && selectedAnchor(this.view!.body, range);
    if (!anchor) { this.report("请先在阅读正文中选择文字"); return; }
    const item = { id: crypto.randomUUID(), key: this.view!.key, anchor, note: "" };
    if (edit) this.edit(item, true);
    else this.change(() => this.store.put(item));
  }

  private change(save: () => void) {
    try {
      save();
      this.refresh();
      if (this.dialog?.open) this.list();
    } catch (error) {
      const message = this.dialog?.querySelector<HTMLElement>("[role=status]");
      if (message) message.textContent = `批注保存失败：${String(error)}`;
      else this.report(error);
    }
  }

  private close() {
    this.dialog?.close();
    this.dialog?.remove();
    this.dialog = undefined;
    this.replacement = null;
  }

  private sheet(title: string) {
    if (!this.dialog) {
      this.dialog = document.createElement("dialog");
      this.dialog.className = "reading-annotation-dialog";
      this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
      document.body.append(this.dialog);
      this.dialog.showModal();
    }
    this.dialog.ariaLabel = title;
    const head = document.createElement("header");
    const heading = document.createElement("h2");
    heading.textContent = title;
    head.append(heading, button("关闭", () => this.close()));
    const status = document.createElement("output");
    status.setAttribute("role", "status");
    this.dialog.replaceChildren(head, status);
    return this.dialog;
  }

  private edit(item: ReadingAnnotation, fresh: boolean) {
    const dialog = this.sheet(fresh ? "写批注" : "修改批注");
    const quote = document.createElement("blockquote");
    quote.textContent = item.anchor.quote;
    const field = document.createElement("textarea");
    field.ariaLabel = "批注内容";
    field.value = item.note;
    const actions = document.createElement("footer");
    actions.append(button("取消", () => fresh ? this.close() : this.list()),
      button("保存批注", () => this.change(() => this.store.put({ id: item.id, key: item.key, anchor: item.anchor, note: field.value.trim() }))));
    dialog.append(quote, field, actions);
    field.focus();
  }

  private list() {
    const view = this.view!;
    const dialog = this.sheet("阅读批注");
    const title = document.createElement("p");
    title.textContent = view.title;
    dialog.append(title);
    const rows = document.createElement("ul");
    for (const entry of this.entries) {
      const { anchor, resolution } = entry;
      const row = document.createElement("li");
      const description = document.createElement("small");
      description.textContent = `${anchor.sectionLabel || "文档开头"} · ${locationLabel(resolution)}`;
      const quote = document.createElement("blockquote");
      quote.textContent = anchor.quote;
      const actions = document.createElement("footer");
      const jump = button("回到原文", () => {
        if (resolution.status !== "matched") return;
        this.close();
        revealReadingSpan(this.view!.body, this.view!.pane, resolution.start, anchor.quote.length);
      });
      jump.disabled = resolution.status !== "matched";
      actions.append(jump, button("修改", () => this.edit(entry, false)), button("删除", () => {
        actions.replaceChildren(button("确认删除", () => this.change(() => this.store.remove(entry.id))), button("取消", () => this.list()));
        actions.querySelector("button")?.focus();
      }));
      const replacement = this.replacement;
      if (replacement) actions.append(button("改为当前选区", () => this.change(() => {
        this.store.put({ id: entry.id, key: entry.key, note: entry.note, anchor: replacement });
        this.replacement = null;
      })));
      row.append(description, quote);
      if (entry.note) {
        const note = document.createElement("p");
        note.textContent = entry.note;
        row.append(note);
      }
      row.append(actions);
      rows.append(row);
    }
    if (!this.entries.length) title.append(" · 暂无批注");
    dialog.append(rows);
    const exportButton = button("导出 Markdown 摘录", async () => {
      try { await view.exportFile(markdownExcerpts(view.title, this.entries)); }
      catch (error) { dialog.querySelector("output")!.textContent = `导出失败：${String(error)}`; }
    });
    exportButton.disabled = !this.entries.length;
    dialog.append(exportButton);
    try {
      const otherKeys = this.store.fileKeys().filter(key => key !== view.key);
      if (view.key.startsWith("file:") && otherKeys.length) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "关联已移动文件的批注";
        const previous = document.createElement("select");
        previous.ariaLabel = "移动前的文件";
        for (const key of otherKeys) previous.add(new Option(key.slice(5), key));
        details.append(summary, previous, button("将批注移至当前文件", () => {
          this.change(() => this.store.remap(key => key === previous.value ? view.key : key));
        }));
        dialog.append(details);
      }
    } catch (error) { dialog.querySelector("output")!.textContent = String(error); }
    dialog.querySelector("button")?.focus();
  }
}
