import { relativeMarkdownResource } from "./markdownPaths";
import { backlinks, scanMarkdownWorkspace, type ReferenceScan, type ReferenceScanOptions, type WorkspaceReference } from "./markdownWorkspaceReferences";

type View = "issues" | "backlinks";

type PanelActions = {
  options: () => ReferenceScanOptions;
  currentPath: () => string | null;
  openPanel: () => void;
  openSource: (row: WorkspaceReference) => Promise<void>;
  showError: (error: unknown) => void;
};

export class MarkdownReferencePanel {
  private root = "";
  private settings = "";
  private report?: ReferenceScan;
  private controller?: AbortController;
  private view: View = "issues";
  private target = "";
  private anchor = "";
  private shown = 100;
  private readonly status = document.getElementById("referenceScanStatus")!;
  private readonly body = document.getElementById("referenceRows")!;
  private readonly sections = document.getElementById("referenceSection") as HTMLSelectElement;
  private readonly scanButton = document.getElementById("referenceRescan") as HTMLButtonElement;
  private readonly cancelButton = document.getElementById("referenceCancel") as HTMLButtonElement;

  constructor(private readonly actions: PanelActions) {
    const run = (action: () => Promise<void>) => () => void action().catch(actions.showError);
    this.scanButton.onclick = run(() => this.show(this.view, true));
    this.cancelButton.onclick = () => {
      this.controller?.abort();
      this.cancelButton.disabled = true;
      this.status.textContent = "正在取消扫描…";
    };
    document.getElementById("referenceIssues")!.onclick = run(() => this.show("issues"));
    document.getElementById("referenceBacklinks")!.onclick = run(() => this.show("backlinks"));
    this.sections.onchange = () => { this.anchor = this.sections.value; this.shown = 100; this.render(); };
  }

  get available() { return Boolean(this.root); }

  reset() {
    this.controller?.abort();
    this.controller = undefined;
    this.report = undefined;
    this.root = "";
    this.body.replaceChildren();
  }

  async show(view: View, refresh = false) {
    const options = this.actions.options();
    const target = view === "backlinks" ? this.actions.currentPath() : null;
    if (view === "backlinks" && !target && !(refresh && this.target)) throw Error("请打开已保存的 Markdown 文档以查看反向引用");
    const settings = JSON.stringify([options.root, options.includeHidden, options.skipDirs]);
    if (this.settings !== settings) this.reset();
    this.settings = settings;
    this.root = options.root;
    this.view = view;
    if (view === "backlinks" && !refresh) this.target = target!;
    this.anchor = "";
    this.shown = 100;
    this.actions.openPanel();
    const scan = refresh || !this.controller && !this.report;
    if (!scan) { this.render(); return; }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.report = undefined;
    this.render();
    try {
      const report = await scanMarkdownWorkspace(options, controller.signal, scanned => {
        if (this.controller === controller && !controller.signal.aborted) this.status.textContent = `正在扫描 · 已检查 ${scanned} 篇`;
      });
      if (this.controller === controller) this.report = report;
    } finally {
      if (this.controller === controller) { this.controller = undefined; this.render(); }
    }
  }

  private render() {
    const report = this.report;
    const incoming = this.view === "backlinks";
    const scanning = Boolean(this.controller);
    const title = document.getElementById("referenceTitle")!;
    title.textContent = incoming ? `反向引用 · ${relativeMarkdownResource(this.root, this.target)}` : "工作区链接检查";
    title.title = incoming ? this.target : this.root;
    this.cancelButton.hidden = !scanning;
    this.cancelButton.disabled = this.controller?.signal.aborted ?? false;
    this.scanButton.hidden = scanning;
    this.sections.hidden = !incoming || !report;
    this.body.replaceChildren();
    if (!report) {
      this.status.textContent = scanning ? "正在扫描…" : "未取得扫描结果，请重新扫描";
      return;
    }
    let rows: WorkspaceReference[];
    if (incoming) {
      rows = backlinks(report, this.target);
      const anchors = [...new Set(rows.map(row => row.anchor).filter(Boolean))].sort();
      this.sections.replaceChildren(new Option("整篇文档", ""), ...anchors.map(id => new Option("#" + id, id)));
      this.sections.value = this.anchor;
      if (this.anchor) rows = rows.filter(row => row.anchor === this.anchor);
    } else rows = report.references.filter(row => row.reason);
    const state = report.cancelled ? "已取消（部分结果）" : report.limited ? "已达上限（部分结果）"
      : report.warningCount ? "扫描结束（部分文件未检查）" : "扫描完成";
    this.status.textContent = `${state} · ${report.scanned} 篇 · ${report.references.length} 处引用 · ${rows.length} ${incoming ? "处来源" : "项异常"}`
      + (report.excluded ? ` · 排除 ${report.excluded} 项（目录规则、隐藏项或符号链接）` : "");
    if (report.warningCount) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `扫描提示 ${report.warningCount} 条` + (report.warningCount > report.warnings.length ? "（仅显示前 100 条）" : "");
      details.append(summary);
      for (const warning of report.warnings) {
        const item = document.createElement("div"); item.textContent = warning; details.append(item);
      }
      this.body.append(details);
    }
    for (const row of rows.slice(0, this.shown)) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "find-result-row";
      button.textContent = `${relativeMarkdownResource(this.root, row.source)}:${row.line}:${row.column}　${row.href}` + (row.reason ? `　${row.reason}` : "");
      button.title = button.textContent;
      button.onclick = () => void this.actions.openSource(row).catch(this.actions.showError);
      this.body.append(button);
    }
    if (rows.length > this.shown) {
      const more = document.createElement("button"); more.type = "button"; more.className = "tool-button";
      more.textContent = `显示更多（剩余 ${rows.length - this.shown}）`;
      more.onclick = () => { this.shown += 100; this.render(); };
      this.body.append(more);
    }
  }
}
