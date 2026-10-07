import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditor.contribution";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";

let nextDialogId = 0;

export function createWorkbenchDialog(title: string) {
  const previousFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "workbench-dialog";
  const heading = document.createElement("h2");
  heading.id = `workbench-dialog-title-${++nextDialogId}`;
  heading.textContent = title;
  dialog.setAttribute("aria-labelledby", heading.id);
  const body = document.createElement("div");
  body.className = "workbench-dialog-body";
  const actions = document.createElement("div");
  actions.className = "workbench-dialog-actions";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "关闭";
  const close = () => { if (dialog.open) dialog.close(); };
  closeButton.addEventListener("click", close);
  actions.append(closeButton);
  dialog.append(heading, body, actions);
  document.body.append(dialog);
  const closed = new Promise<void>((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve();
    }, { once: true });
  });
  dialog.showModal();
  return { dialog, body, actions, close, closed };
}

export type ComparisonOptions = {
  title: string;
  original: string;
  modified: string;
  language: string;
  theme: string;
  actions?: Array<{ label: string; onClick: () => void | Promise<void> }>;
};

export async function showComparison(options: ComparisonOptions): Promise<void> {
  const panel = createWorkbenchDialog(options.title);
  panel.dialog.classList.add("workbench-comparison-dialog");
  const legend = document.createElement("p");
  legend.className = "workbench-comparison-legend";
  legend.textContent = "左侧：原始版本　右侧：当前或预期版本";
  const host = document.createElement("div");
  host.className = "workbench-diff-editor";
  host.style.height = "min(65vh, 700px)";
  host.style.minHeight = "240px";
  const error = document.createElement("p");
  error.className = "workbench-error";
  error.setAttribute("role", "alert");
  panel.body.append(legend, host, error);
  const original = monaco.editor.createModel(options.original, options.language);
  const modified = monaco.editor.createModel(options.modified, options.language);
  let editor: monaco.editor.IStandaloneDiffEditor | undefined;
  try {
    editor = monaco.editor.createDiffEditor(host, {
      theme: options.theme,
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      accessibilitySupport: "auto",
    });
    editor.setModel({ original, modified });
    for (const action of options.actions ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", async () => {
        const buttons = [...panel.actions.querySelectorAll("button")];
        buttons.forEach((item) => { item.disabled = true; });
        error.textContent = "";
        try {
          await action.onClick();
          panel.close();
        } catch (reason) {
          error.textContent = reason instanceof Error ? reason.message : String(reason);
        } finally {
          buttons.forEach((item) => { item.disabled = false; });
        }
      });
      panel.actions.prepend(button);
    }
    editor.getModifiedEditor().focus();
    await panel.closed;
  } finally {
    editor?.dispose();
    original.dispose();
    modified.dispose();
    panel.close();
  }
}

export type SideEditorOptions = {
  theme: string;
  fontSize: number;
  fontFamily: string;
  readOnly?: boolean;
  onClose: () => void;
};

/** Owns the view only; shared document models belong to the application. */
export function createSideEditor(
  container: HTMLElement,
  model: monaco.editor.ITextModel | null,
  options: SideEditorOptions,
) {
  const wrapper = document.createElement("section");
  wrapper.className = "workbench-side-editor";
  wrapper.setAttribute("aria-label", "并排编辑器");
  Object.assign(wrapper.style, { display: "flex", flexDirection: "column", height: "100%", minWidth: "0" });
  const toolbar = document.createElement("div");
  toolbar.className = "workbench-side-toolbar";
  const title = document.createElement("span");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭并排视图";
  close.addEventListener("click", options.onClose);
  toolbar.append(title, close);
  const host = document.createElement("div");
  host.className = "workbench-side-editor-host";
  Object.assign(host.style, { flex: "1", minHeight: "0" });
  wrapper.append(toolbar, host);
  container.append(wrapper);
  const editor = monaco.editor.create(host, {
    model,
    theme: options.theme,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    readOnly: options.readOnly ?? false,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  });
  const refreshTitle = () => {
    const uri = editor.getModel()?.uri;
    title.textContent = uri ? (uri.path.split(/[\\/]/).pop() || "文档") : "无文档";
    title.title = uri?.toString() ?? "";
  };
  refreshTitle();
  let synchronizers: monaco.IDisposable[] = [];
  let synchronizing = false;
  const stopSync = () => {
    synchronizers.forEach((item) => item.dispose());
    synchronizers = [];
  };
  return {
    editor,
    setModel(next: monaco.editor.ITextModel | null) { editor.setModel(next); refreshTitle(); },
    updateOptions(next: monaco.editor.IEditorOptions) { editor.updateOptions(next); },
    setSync(primary: monaco.editor.IStandaloneCodeEditor, enabled: boolean) {
      stopSync();
      if (!enabled || primary === editor) return;
      const sync = (source: monaco.editor.IStandaloneCodeEditor, target: monaco.editor.IStandaloneCodeEditor) => {
        if (synchronizing) return;
        synchronizing = true;
        try {
          const sourceRange = Math.max(0, source.getScrollHeight() - source.getLayoutInfo().height);
          const targetRange = Math.max(0, target.getScrollHeight() - target.getLayoutInfo().height);
          target.setScrollTop(sourceRange ? source.getScrollTop() / sourceRange * targetRange : 0);
        } finally { synchronizing = false; }
      };
      synchronizers = [
        primary.onDidScrollChange((event) => { if (event.scrollTopChanged) sync(primary, editor); }),
        editor.onDidScrollChange((event) => { if (event.scrollTopChanged) sync(editor, primary); }),
      ];
      sync(primary, editor);
    },
    dispose() { stopSync(); editor.dispose(); wrapper.remove(); },
  };
}

export type SnapshotItem = {
  id: number;
  title: string;
  path?: string | null;
  createdAt: number;
  byteLength: number;
};

export async function showSnapshotPicker<T extends SnapshotItem>(
  items: readonly T[],
  onSelect: (item: T) => void | Promise<void>,
  onDelete?: (item: T) => void | Promise<void>,
): Promise<void> {
  const panel = createWorkbenchDialog("恢复副本与本地历史");
  const list = document.createElement("ul");
  list.className = "workbench-snapshot-list";
  const error = document.createElement("p");
  error.className = "workbench-error";
  error.setAttribute("role", "alert");
  const empty = document.createElement("p");
  empty.textContent = "暂无可用副本。";
  empty.hidden = items.length > 0;
  panel.body.append(empty, list, error);
  let busy = false;
  const run = async (action: () => void | Promise<void>) => {
    if (busy) return;
    busy = true;
    list.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    error.textContent = "";
    try { await action(); }
    catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); }
    finally {
      busy = false;
      list.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      empty.hidden = list.children.length > 0;
    }
  };
  for (const item of items) {
    const row = document.createElement("li");
    const select = document.createElement("button");
    select.type = "button";
    select.className = "workbench-snapshot-select";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const details = document.createElement("span");
    details.textContent = `${new Date(item.createdAt).toLocaleString()} · ${item.byteLength.toLocaleString()} 字节${item.path ? ` · ${item.path}` : ""}`;
    select.append(title, details);
    select.addEventListener("click", () => void run(() => onSelect(item)));
    row.append(select);
    if (onDelete) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "删除副本";
      remove.setAttribute("aria-label", `删除 ${item.title} 的这份副本`);
      remove.addEventListener("click", () => void run(async () => {
        await onDelete(item);
        const next = row.nextElementSibling ?? row.previousElementSibling;
        row.remove();
        (next?.querySelector("button") ?? panel.actions.querySelector("button"))?.focus();
      }));
      row.append(remove);
    }
    list.append(row);
  }
  list.querySelector("button")?.focus();
  await panel.closed;
}
