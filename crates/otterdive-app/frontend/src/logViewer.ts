import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import { createWorkbenchDialog } from "./workbenchPanels";
import {
  logChunkRequest, nextLogFollowAction, retainLogWindow, shouldPauseLogFollow,
  type FileChunk, type LogReadAction,
} from "./logViewerState";

export async function openLogViewer(
  path: string, options: { theme: string; fontSize: number; fontFamily: string },
): Promise<void> {
  const panel = createWorkbenchDialog(`日志分块阅读 · ${path.split(/[\\/]/).pop() || path}`);
  panel.dialog.classList.add("workbench-log-dialog");
  const toolbar = document.createElement("div");
  toolbar.className = "workbench-log-toolbar";
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", "日志分页与跟随");
  const buttons = new Map<LogReadAction, HTMLButtonElement>();
  for (const [action, label] of [["start", "文件开头"], ["previous", "上一页"], ["next", "下一页"], ["end", "文件末尾"]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      pause();
      void read(action, false);
    });
    buttons.set(action, button);
    toolbar.append(button);
  }
  const followButton = document.createElement("button");
  followButton.type = "button";
  followButton.addEventListener("click", () => {
    if (following) pause();
    else {
      following = true;
      refreshControls();
      void read("end", false);
    }
  });
  const encodingLabel = document.createElement("label");
  encodingLabel.textContent = "编码 ";
  const encoding = document.createElement("select");
  encoding.setAttribute("aria-label", "日志读取编码");
  for (const value of ["auto", "UTF-8", "UTF-8-BOM", "UTF-16 Little Endian", "UTF-16 Big Endian", "GBK", "Big5", "Shift-JIS", "Windows-1252"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "auto" ? "自动（BOM / UTF-8）" : value;
    encoding.append(option);
  }
  encodingLabel.append(encoding);
  encoding.addEventListener("change", () => {
    cursor = null;
    chunks = [];
    applyText("", false);
    void read(following ? "end" : "start", false);
  });
  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.textContent = "搜索显示内容";
  searchButton.addEventListener("click", () => {
    pause();
    editor.focus();
    void editor.getAction("actions.find")?.run();
  });
  toolbar.append(followButton, encodingLabel, searchButton);
  const status = document.createElement("p");
  status.className = "workbench-log-status";
  status.setAttribute("role", "status");
  const notice = document.createElement("p");
  notice.className = "workbench-log-notice";
  notice.textContent = "仅保留最近 2 MiB 显示内容；搜索仅限当前窗口。向上滚动会暂停跟随。";
  const error = document.createElement("p");
  error.className = "workbench-error";
  error.setAttribute("role", "alert");
  const host = document.createElement("div");
  host.className = "workbench-log-editor";
  host.style.height = "min(65vh, 700px)";
  host.style.minHeight = "240px";
  panel.body.append(toolbar, status, notice, error, host);
  const model = monaco.editor.createModel("", "plaintext");
  const editor = monaco.editor.create(host, {
    model, theme: options.theme, fontSize: options.fontSize, fontFamily: options.fontFamily,
    readOnly: true, domReadOnly: true, automaticLayout: true,
    minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: "off",
    ariaLabel: `日志 ${path}，只读分块窗口`,
  });
  let cursor: FileChunk | null = null;
  let chunks: FileChunk[] = [];
  let following = true;
  let disposed = false;
  let busy = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scrollGuard = 0;
  let releaseScrollGuard: ReturnType<typeof setTimeout> | undefined;
  let previousScrollTop = 0;

  function clearPoll() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function refreshControls() {
    followButton.textContent = following ? "暂停跟随" : "继续跟随";
    followButton.setAttribute("aria-pressed", String(following));
    for (const [action, button] of buttons) {
      button.disabled = (busy && !following) || ((action === "start" || action === "previous")
        && (!cursor || (chunks[0]?.startOffset ?? cursor.startOffset) <= 3))
        || (action === "next" && (!cursor || !cursor.hasMore));
    }
    if (!cursor) status.textContent = busy ? "正在读取日志…" : "等待读取日志";
    else {
      const first = chunks[0]?.startOffset ?? cursor.startOffset;
      status.textContent = `字节 ${first.toLocaleString()}–${cursor.nextOffset.toLocaleString()} / ${cursor.size.toLocaleString()} · ${cursor.encoding} · ${following ? "跟随中" : "已暂停"}${busy && !following ? " · 读取中" : ""}`;
    }
  }
  function pause() {
    following = false;
    generation++; // Discard an in-flight poll so it cannot move a user's paused view.
    busy = false;
    clearPoll();
    refreshControls();
  }
  function schedulePoll() {
    clearPoll();
    if (!disposed && following) timer = setTimeout(() => {
      const action = nextLogFollowAction(cursor);
      if (action === "end") notice.textContent = "新增内容超出显示窗口，已跳至最新日志。上一页可继续向前阅读。";
      void read(action, action === "follow");
    }, 750);
  }
  function applyText(text: string, moveToEnd: boolean) {
    const guard = ++scrollGuard;
    if (releaseScrollGuard !== undefined) clearTimeout(releaseScrollGuard);
    if (model.getValue() !== text) model.setValue(text);
    if (moveToEnd) {
      const line = model.getLineCount();
      editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
      editor.revealLine(line, monaco.editor.ScrollType.Immediate);
    } else {
      editor.setScrollTop(0);
      editor.setPosition({ lineNumber: 1, column: 1 });
    }
    previousScrollTop = editor.getScrollTop();
    // Monaco may emit a follow-up layout scroll event after setting the model.
    releaseScrollGuard = setTimeout(() => { if (scrollGuard === guard) scrollGuard = 0; }, 80);
  }
  async function read(action: LogReadAction, append: boolean) {
    clearPoll();
    const requestGeneration = ++generation;
    busy = true;
    refreshControls();
    const request = logChunkRequest(path, action, cursor, chunks[0]?.startOffset ?? cursor?.startOffset ?? 0, encoding.value);
    try {
      const chunk = await invoke<FileChunk>("read_file_chunk", { request });
      if (disposed || requestGeneration !== generation) return;
      const next = retainLogWindow(chunks, chunk, append);
      const text = next.map((item) => item.text).join("");
      const changed = model.getValue() !== text;
      chunks = next;
      cursor = chunk;
      error.textContent = chunk.warning ?? "";
      if (chunk.reset) notice.textContent = "文件已被替换、重写或截断，显示窗口已重新读取。";
      if (changed || !append) applyText(text, following || action === "end");
    } catch (reason) {
      if (!disposed && requestGeneration === generation) {
        error.textContent = `${reason instanceof Error ? reason.message : String(reason)}${following ? "；保持跟随，稍后重试。" : ""}`;
      }
    } finally {
      if (!disposed && requestGeneration === generation) {
        busy = false;
        refreshControls();
        schedulePoll();
      }
    }
  }
  const scrollListener = editor.onDidScrollChange((event) => {
    if (event.scrollTopChanged && shouldPauseLogFollow(following, previousScrollTop, event.scrollTop, scrollGuard !== 0)) pause();
    previousScrollTop = event.scrollTop;
  });
  const wheelListener = (event: WheelEvent) => { if (event.deltaY < 0 && following) pause(); };
  const keyListener = (event: KeyboardEvent) => {
    if (following && (["ArrowUp", "PageUp", "Home"].includes(event.key) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f"))) pause();
  };
  host.addEventListener("wheel", wheelListener, { passive: true });
  host.addEventListener("keydown", keyListener);
  refreshControls();
  void read("end", false);
  try {
    await panel.closed;
  } finally {
    disposed = true;
    generation++;
    clearPoll();
    if (releaseScrollGuard !== undefined) clearTimeout(releaseScrollGuard);
    host.removeEventListener("wheel", wheelListener);
    host.removeEventListener("keydown", keyListener);
    scrollListener.dispose();
    editor.dispose();
    model.dispose();
  }
}
