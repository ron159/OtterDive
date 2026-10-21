import { selectedResultLineIndices, type PinnedResultInput } from "./pinnedSearchResult";
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor/editor";
import {
  resolveAnalyseEnterAction,
  type AnalyseEnterAction,
} from "./analyseState";

type AnalyseSearchType = "normal" | "escaped" | "regex" | "regexMultiline";
type AnalyseSelection = "line" | "text";
export type AnalyseProfileLoadMode = "replace" | "append" | "prepend";

export interface AnalysePanelSettings {
  autoUpdate: boolean;
  searchAllOpenFiles: boolean;
  showLineNumbers: boolean;
  wordWrap: boolean;
  fontSize: number;
  scrollSync: boolean;
  boundResultPath: string | null;
  enterAction: AnalyseEnterAction;
  workingPatterns: AnalysePattern[];
}

export interface AnalyseDocumentSnapshot {
  id: number;
  revision: number;
  text: string;
  title: string;
  path: string | null;
  fileSize: number;
  dirty: boolean;
  largeFile: boolean;
  encoding?: string;
  diskRevision?: string | null;
}

export interface AnalysePanelHost {
  getActiveDocumentId: () => number;
  getDocument: () => AnalyseDocumentSnapshot;
  getDocuments: () => AnalyseDocumentSnapshot[];
  getDocumentRevisions: () => Array<{ id: number; revision: number }>;
  getSelectedText: () => string;
  getSourceLine: () => number;
  navigate: (documentId: number, line: number) => void;
  revealSource: (documentId: number, line: number) => void;
  setBookmarkLines: (documentId: number, lines: number[]) => void;
  setResultVisible: (visible: boolean) => void;
  getRecentProfilePaths: () => string[];
  rememberProfilePath: (path: string) => void;
  getDefaultDirectory: () => string | null;
  getSettings: () => AnalysePanelSettings;
  updateSettings: (settings: AnalysePanelSettings) => void;
  pinResults: (results: readonly PinnedResultInput[]) => void;
  log: (message: string) => void;
}

export interface AnalysePanelController {
  addSelectionAsPattern: (text: string) => void;
  cancel: () => void;
  clearPatterns: () => void;
  focusOptions: () => void;
  focusResult: () => void;
  layout: () => void;
  loadProfile: () => Promise<void>;
  loadProfilePath: (path: string, mode?: AnalyseProfileLoadMode) => Promise<void>;
  notifyDocumentChanged: (documentId: number) => void;
  run: () => Promise<void>;
  saveProfile: () => Promise<void>;
  syncDocument: () => void;
  syncRecentProfiles: () => void;
  syncSettings: () => void;
  syncSourceLine: (line: number) => void;
}

export interface AnalysePattern {
  id: number;
  orderNum: string;
  enabled: boolean;
  searchText: string;
  searchType: AnalyseSearchType;
  matchCase: boolean;
  wholeWord: boolean;
  selection: AnalyseSelection;
  hide: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  foreground: string;
  background: string;
  comment: string;
  group: string;
}

interface AnalyseRunResponse {
  runId: number;
  documentId: number;
  documentRevision: number;
  patternRevision: number;
  lines: AnalyseLine[];
  totalMatches: number;
  patternHits: Array<{ patternId: number; hits: number }>;
  patternErrors: Array<{ patternId: number; kind: string; message: string }>;
  totalLines: number;
  resultToken?: string | null;
  documentCount?: number;
}

interface AnalyseResultChunk {
  lines: AnalyseLine[];
  nextOffset: number;
  done: boolean;
}

interface AnalyseLine {
  sourceLine: number;
  text: string;
  matchingPatternIds: number[];
  styledSegments: StyledSegment[];
  sourceDocumentId?: number;
  sourceDocumentTitle?: string;
  sourceDocumentPath?: string | null;
}

interface StyledSegment {
  startByteInLine: number;
  endByteInLine: number;
  patternId?: number | null;
  hidden: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  foreground: string;
  background: string;
}

interface ResultLineMapping {
  resultLine: number;
  sourceDocumentId: number;
  sourceLine: number;
  sourceDocumentTitle: string;
  matchingPatternIds: number[];
}

interface ParsedAnalyseProfile {
  patterns: AnalysePattern[];
  nextPatternId: number;
}

interface AnalyseResultFindMatch {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

const DEFAULT_FOREGROUND = "#D32F2F";
const DEFAULT_BACKGROUND = "#FFFFFF";

export function createAnalysePanel(
  container: HTMLElement,
  resultContainer: HTMLElement,
  host: AnalysePanelHost,
): AnalysePanelController {
  container.innerHTML = panelMarkup();
  resultContainer.innerHTML = resultMarkup();
  const element = <T extends HTMLElement>(role: string) => {
    const found = container.querySelector<T>(`[data-analyse-role="${role}"]`)
      ?? resultContainer.querySelector<T>(`[data-analyse-role="${role}"]`);
    if (!found) throw new Error(`Missing Analyse control: ${role}`);
    return found;
  };

  const patterns: AnalysePattern[] = [];
  const hits = new Map<number, number>();
  const errors = new Map<number, string>();
  let selectedPatternId: number | null = null;
  let nextPatternId = 1;
  let patternRevision = 0;
  let nextRunId = 0;
  const resultDocumentIds = new Set<number>();
  let latestResult: AnalyseRunResponse | null = null;
  let resultMapping: ResultLineMapping[] = [];
  let currentProfilePath: string | null = null;
  let boundResultPath: string | null = null;
  let activeRunId: number | null = null;
  let autoRunTimer = 0;
  let resultFindMatches: monaco.Range[] = [];
  let activeResultFindIndex = -1;
  let resultFindSignature = "";
  let syncingFromSource = false;
  let syncingFromResult = false;
  let resultWheelZoomAt = 0;

  const resultModel = monaco.editor.createModel(
    "",
    "plaintext",
    monaco.Uri.parse(`otterdive://analyse/result-${Date.now()}`),
  );
  const resultEditor = monaco.editor.create(element("result-editor"), {
    model: resultModel,
    readOnly: true,
    domReadOnly: true,
    minimap: { enabled: false },
    lineNumbers: "off",
    glyphMargin: false,
    folding: false,
    renderLineHighlight: "line",
    scrollBeyondLastLine: false,
    wordWrap: "off",
    automaticLayout: true,
    largeFileOptimizations: true,
    fontSize: 12,
    lineHeight: 19,
    padding: { top: 6, bottom: 6 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  });
  const resultDecorations = resultEditor.createDecorationsCollection();
  const resultFindDecorations = resultEditor.createDecorationsCollection();
  const resultSelectionDecorations = resultEditor.createDecorationsCollection();
  resultEditor.onDidChangeCursorSelection(() => {
    const selections = resultEditor.getSelections()?.filter((selection) => !selection.isEmpty()) ?? [];
    resultSelectionDecorations.set(selections.map((selection) => ({
      range: selection,
      options: { inlineClassName: "analyse-result-selected-text" },
    })));
  });
  const styleElement = document.createElement("style");
  styleElement.dataset.analyseStyles = "true";
  resultContainer.appendChild(styleElement);

  writeDraft(defaultPattern(0));
  applySettings();
  bindActions();
  renderPatterns();
  renderRecentProfiles();
  setStatus("添加 Pattern，让水獭帮你梳理当前文档");

  function bindActions() {
    element("run").addEventListener("click", () => void run());
    element("cancel").addEventListener("click", () => cancelActiveRun());
    element("clear-result").addEventListener("click", clearResultState);
    element("pin-result").addEventListener("mousedown", event => event.preventDefault());
    element("pin-result").addEventListener("click", pinResultSelection);
    resultEditor.addAction({ id: "otterdive.analyse.pin-result", label: "固定选中结果行用于对比",
      contextMenuGroupId: "navigation", contextMenuOrder: 2, run: pinResultSelection });
    element("add").addEventListener("click", addPattern);
    element("add-selection").addEventListener("click", () => {
      addSelectionAsPattern(host.getSelectedText());
    });
    element("update").addEventListener("click", updatePattern);
    element("delete").addEventListener("click", deletePattern);
    element("clear-patterns").addEventListener("click", clearPatterns);
    element("enable-all").addEventListener("click", () => setAllPatternsEnabled(true));
    element("disable-all").addEventListener("click", () => setAllPatternsEnabled(false));
    element("enable-group").addEventListener("click", () => setSelectedGroupEnabled(true));
    element("disable-group").addEventListener("click", () => setSelectedGroupEnabled(false));
    element("up").addEventListener("click", () => movePattern(-1));
    element("down").addEventListener("click", () => movePattern(1));
    element("sort").addEventListener("click", sortPatterns);
    element("load-profile").addEventListener("click", () => void loadProfile());
    element("save-profile").addEventListener("click", () => void saveProfile());
    element("recent-profile-open").addEventListener("click", () => {
      const path = select("recent-profile").value;
      if (path) void loadProfilePath(path, selectedProfileLoadMode());
    });
    element("show-lines").addEventListener("change", () => {
      renderResult();
      persistSettings();
      void writeBoundResult();
    });
    element("auto-update").addEventListener("change", () => {
      persistSettings();
      scheduleAutoRun();
    });
    element("all-open-files").addEventListener("change", () => {
      persistSettings();
      invalidateResult();
      setStatus(input("all-open-files").checked ? "已切换为分析全部打开文件" : "已切换为分析当前文档");
    });
    element("scroll-sync").addEventListener("change", () => {
      persistSettings();
      if (input("scroll-sync").checked) syncSourceLine(host.getSourceLine());
    });
    element("enter-action").addEventListener("change", persistSettings);
    element("copy-result").addEventListener("click", () => void copyResult(false));
    element("copy-result-rtf").addEventListener("click", () => void copyResult(true));
    element("save-result").addEventListener("click", () => void saveResult(false));
    element("save-result-rtf").addEventListener("click", () => void saveResult(true));
    element("bind-result").addEventListener("click", () => void bindResult());
    element("unbind-result").addEventListener("click", unbindResult);
    element("result-find-next").addEventListener("click", () => void findResult(1));
    element("result-find-previous").addEventListener("click", () => void findResult(-1));
    element("result-find-input").addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "Enter") return;
      keyboardEvent.preventDefault();
      void findResult(keyboardEvent.shiftKey ? -1 : 1);
    });
    element("word-wrap").addEventListener("change", () => {
      resultEditor.updateOptions({
        wordWrap: input("word-wrap").checked ? "on" : "off",
      });
      persistSettings();
    });
    element("result-font").addEventListener("change", () => {
      setResultFontSize(Number(input("result-font").value) || 12);
    });
    element("result-editor").addEventListener("wheel", handleResultWheelZoom, {
      capture: true,
      passive: false,
    });
    element("pattern-list").addEventListener("click", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-pattern-id]");
      if (row) selectPattern(Number(row.dataset.patternId));
    });
    element("pattern-list").addEventListener("dblclick", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-pattern-id]");
      if (!row) return;
      const pattern = patterns.find((item) => item.id === Number(row.dataset.patternId));
      if (!pattern) return;
      pattern.enabled = !pattern.enabled;
      invalidateResult(false);
      if (pattern.id === selectedPatternId) writeDraft(pattern);
      renderPatterns();
      persistSettings();
      void run();
    });
    element("pattern-list").addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "ArrowDown" && keyboardEvent.key !== "ArrowUp") return;
      keyboardEvent.preventDefault();
      const index = Math.max(0, patterns.findIndex((item) => item.id === selectedPatternId));
      const next = Math.min(
        patterns.length - 1,
        Math.max(0, index + (keyboardEvent.key === "ArrowDown" ? 1 : -1)),
      );
      if (patterns[next]) selectPattern(patterns[next].id, true);
    });
    element("search-text").addEventListener("keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        const selected = patterns.find((item) => item.id === selectedPatternId);
        writeDraft(selected ?? defaultPattern(0));
        setStatus("已放弃未提交的 Pattern 修改");
        return;
      }
      if (keyboardEvent.key === "Enter") {
        keyboardEvent.preventDefault();
        handleEnterAction();
      }
    });
    resultEditor.onMouseDown((event) => {
      if (event.event.detail < 2 || !event.target.position) return;
      const mapping = resultMapping[event.target.position.lineNumber - 1];
      if (mapping) host.navigate(mapping.sourceDocumentId, mapping.sourceLine);
    });
    resultEditor.onDidChangeCursorPosition(({ position }) => {
      renderMatchingPatterns(position.lineNumber);
    });
    resultEditor.onDidScrollChange(() => {
      if (!input("scroll-sync").checked || syncingFromSource || !latestResult) return;
      const lineNumber = resultEditor.getVisibleRanges()[0]?.startLineNumber;
      const mapping = lineNumber ? resultMapping[lineNumber - 1] : undefined;
      if (!mapping) return;
      syncingFromResult = true;
      host.revealSource(mapping.sourceDocumentId, mapping.sourceLine);
      queueMicrotask(() => { syncingFromResult = false; });
    });
  }

  function handleResultWheelZoom(event: WheelEvent) {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (resultWheelZoomAt !== 0 && now - resultWheelZoomAt < 55) return;
    resultWheelZoomAt = now;
    const currentFontSize = Number(input("result-font").value) || 12;
    setResultFontSize(currentFontSize + (event.deltaY < 0 ? 1 : -1));
  }

  function setResultFontSize(value: number) {
    const fontSize = Math.min(24, Math.max(10, value));
    input("result-font").value = String(fontSize);
    resultEditor.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.6) });
    persistSettings();
  }

  function input(role: string) {
    return element<HTMLInputElement>(role);
  }

  function select(role: string) {
    return element<HTMLSelectElement>(role);
  }

  function readDraft(id: number): AnalysePattern {
    return {
      id,
      orderNum: input("order").value.trim(),
      enabled: input("enabled").checked,
      searchText: input("search-text").value,
      searchType: select("search-type").value as AnalyseSearchType,
      matchCase: input("match-case").checked,
      wholeWord: input("whole-word").checked,
      selection: select("selection").value as AnalyseSelection,
      hide: input("hide").checked,
      bold: input("bold").checked,
      italic: input("italic").checked,
      underline: input("underline").checked,
      foreground: input("foreground").value.toUpperCase(),
      background: input("background").value.toUpperCase(),
      comment: input("comment").value,
      group: input("group").value,
    };
  }

  function writeDraft(pattern: AnalysePattern) {
    input("order").value = pattern.orderNum;
    input("enabled").checked = pattern.enabled;
    input("search-text").value = pattern.searchText;
    select("search-type").value = pattern.searchType;
    input("match-case").checked = pattern.matchCase;
    input("whole-word").checked = pattern.wholeWord;
    select("selection").value = pattern.selection;
    input("hide").checked = pattern.hide;
    input("bold").checked = pattern.bold;
    input("italic").checked = pattern.italic;
    input("underline").checked = pattern.underline;
    input("foreground").value = pattern.foreground;
    input("background").value = pattern.background;
    input("comment").value = pattern.comment;
    input("group").value = pattern.group;
  }

  function draftChanged() {
    const current = patterns.find((item) => item.id === selectedPatternId);
    return current ? JSON.stringify(current) !== JSON.stringify(readDraft(current.id)) : true;
  }

  function addPattern() {
    const pattern = readDraft(nextPatternId++);
    if (!pattern.searchText) {
      setStatus("Search Text 不能为空", true);
      input("search-text").focus();
      return;
    }
    const selectedIndex = patterns.findIndex((item) => item.id === selectedPatternId);
    patterns.splice(selectedIndex < 0 ? patterns.length : selectedIndex + 1, 0, pattern);
    selectedPatternId = pattern.id;
    invalidateResult();
    renderPatterns();
    persistSettings();
    setStatus(`已添加 Pattern ${pattern.id}`);
  }

  function addSelectionAsPattern(text: string) {
    if (!text) {
      setStatus("请先在源编辑器中选择文本", true);
      return;
    }
    const pattern = readDraft(nextPatternId++);
    pattern.searchText = text;
    const selectedIndex = patterns.findIndex((item) => item.id === selectedPatternId);
    patterns.splice(selectedIndex < 0 ? patterns.length : selectedIndex + 1, 0, pattern);
    selectedPatternId = pattern.id;
    writeDraft(pattern);
    invalidateResult();
    renderPatterns();
    persistSettings();
    setStatus(`已从源选区添加 Pattern ${pattern.id}`);
  }

  function updatePattern() {
    const index = patterns.findIndex((item) => item.id === selectedPatternId);
    if (index < 0) {
      addPattern();
      return;
    }
    const updated = readDraft(patterns[index].id);
    if (!updated.searchText) {
      setStatus("Search Text 不能为空", true);
      return;
    }
    patterns[index] = updated;
    invalidateResult();
    renderPatterns();
    persistSettings();
    setStatus(`已更新 Pattern ${updated.id}`);
  }

  function deletePattern() {
    const index = patterns.findIndex((item) => item.id === selectedPatternId);
    if (index < 0) return;
    const [removed] = patterns.splice(index, 1);
    hits.delete(removed.id);
    errors.delete(removed.id);
    selectedPatternId = patterns[Math.min(index, patterns.length - 1)]?.id ?? null;
    invalidateResult(false);
    if (selectedPatternId !== null) {
      const selected = patterns.find((item) => item.id === selectedPatternId);
      if (selected) writeDraft(selected);
    } else {
      writeDraft(defaultPattern(0));
    }
    renderPatterns();
    persistSettings();
    scheduleAutoRun();
  }

  function movePattern(delta: number) {
    const index = patterns.findIndex((item) => item.id === selectedPatternId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= patterns.length) return;
    [patterns[index], patterns[target]] = [patterns[target], patterns[index]];
    invalidateResult();
    renderPatterns();
    persistSettings();
    focusSelectedRow();
  }

  function sortPatterns() {
    patterns.sort((left, right) => compareOrder(left.orderNum, right.orderNum));
    invalidateResult();
    renderPatterns();
    persistSettings();
    focusSelectedRow();
  }

  function handleEnterAction() {
    const action = resolveAnalyseEnterAction(
      selectedPatternId !== null,
      draftChanged(),
      select("enter-action").value as AnalyseEnterAction,
    );
    if (action === "update") updatePattern();
    else if (action === "add") addPattern();
    void run();
  }

  function clearPatterns() {
    if (patterns.length === 0) {
      setStatus("Pattern 列表已经为空");
      return;
    }
    patterns.splice(0, patterns.length);
    selectedPatternId = null;
    nextPatternId = 1;
    writeDraft(defaultPattern(0));
    invalidateResult(false);
    renderPatterns();
    persistSettings();
    setStatus("已清空全部 Pattern");
  }

  function setAllPatternsEnabled(enabled: boolean) {
    setPatternsEnabled(patterns, enabled, enabled ? "已启用全部 Pattern" : "已禁用全部 Pattern");
  }

  function setSelectedGroupEnabled(enabled: boolean) {
    const group = (
      patterns.find((item) => item.id === selectedPatternId)?.group
      ?? input("group").value
    ).trim();
    if (!group) {
      setStatus("请先选择带 Group 的 Pattern", true);
      return;
    }
    setPatternsEnabled(
      patterns.filter((pattern) => pattern.group === group),
      enabled,
      `${enabled ? "已启用" : "已禁用"} Group：${group}`,
    );
  }

  function setPatternsEnabled(targets: AnalysePattern[], enabled: boolean, message: string) {
    if (targets.length === 0) {
      setStatus("没有符合条件的 Pattern", true);
      return;
    }
    let changed = false;
    for (const pattern of targets) {
      if (pattern.enabled === enabled) continue;
      pattern.enabled = enabled;
      changed = true;
    }
    if (!changed) {
      setStatus(message);
      return;
    }
    const selected = patterns.find((item) => item.id === selectedPatternId);
    if (selected) writeDraft(selected);
    invalidateResult();
    renderPatterns();
    persistSettings();
    setStatus(message);
  }

  function selectPattern(id: number, focus = false) {
    const pattern = patterns.find((item) => item.id === id);
    if (!pattern) return;
    selectedPatternId = id;
    writeDraft(pattern);
    renderPatterns();
    if (focus) focusSelectedRow();
  }

  function focusSelectedRow() {
    container
      .querySelector<HTMLElement>(`[data-pattern-id="${selectedPatternId}"]`)
      ?.focus();
  }

  function renderPatterns() {
    const body = element<HTMLTableSectionElement>("pattern-list");
    body.replaceChildren();
    for (const [index, pattern] of patterns.entries()) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.dataset.patternId = String(pattern.id);
      row.classList.toggle("selected", pattern.id === selectedPatternId);
      row.classList.toggle("disabled", !pattern.enabled);
      row.style.setProperty("--analyse-pattern-foreground", pattern.foreground);
      row.style.setProperty("--analyse-pattern-background", pattern.background);
      const error = errors.get(pattern.id);
      const values = [
        pattern.enabled ? "●" : "○",
        pattern.orderNum || String(index + 1),
        pattern.searchText,
        searchTypeLabel(pattern.searchType),
        pattern.group || "—",
        String(hits.get(pattern.id) ?? 0),
        error ? "错误" : "就绪",
      ];
      for (const [cellIndex, value] of values.entries()) {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (cellIndex === 2) cell.title = pattern.searchText;
        if (cellIndex === 6 && error) {
          cell.className = "analyse-pattern-error";
          cell.title = error;
        }
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    element("pattern-count").textContent = `${patterns.length} 个 Pattern`;
    element<HTMLButtonElement>("update").disabled = selectedPatternId === null;
    element<HTMLButtonElement>("delete").disabled = selectedPatternId === null;
    element<HTMLButtonElement>("up").disabled = selectedPatternId === null;
    element<HTMLButtonElement>("down").disabled = selectedPatternId === null;
  }

  async function loadProfile() {
    try {
      const path = await invoke<string | null>("pick_file_path", {
        request: { defaultDir: host.getDefaultDirectory() },
      });
      if (path) await loadProfilePath(path, selectedProfileLoadMode());
    } catch (error) {
      reportProfileError("加载 Profile 失败", error);
    }
  }

  async function loadProfilePath(path: string, mode: AnalyseProfileLoadMode = "replace") {
    try {
      const document = await invoke<{ text: string }>("open_path", { path });
      const firstPatternId = mode === "replace" ? 1 : nextPatternId;
      const parsed = await invoke<ParsedAnalyseProfile>("parse_analyse_profile", {
        request: { xml: document.text, firstPatternId },
      });
      if (mode === "replace") patterns.splice(0, patterns.length, ...parsed.patterns);
      else if (mode === "prepend") patterns.unshift(...parsed.patterns);
      else patterns.push(...parsed.patterns);
      nextPatternId = parsed.nextPatternId;
      selectedPatternId = parsed.patterns[0]?.id ?? patterns[0]?.id ?? null;
      const selectedPattern = patterns.find((pattern) => pattern.id === selectedPatternId);
      writeDraft(selectedPattern ?? defaultPattern(0));
      currentProfilePath = path;
      host.rememberProfilePath(path);
      renderRecentProfiles();
      invalidateResult();
      renderPatterns();
      persistSettings();
      setStatus(`${profileModeLabel(mode)} ${fileName(path)}：${parsed.patterns.length} 个 Pattern`);
    } catch (error) {
      reportProfileError(`加载 Profile 失败：${fileName(path)}`, error);
    }
  }

  async function saveProfile() {
    try {
      const xml = await invoke<string>("write_analyse_profile", {
        request: {
          patterns,
          patternHits: [...hits].map(([patternId, patternHits]) => ({ patternId, hits: patternHits })),
        },
      });
      const path = await invoke<string | null>("pick_save_path", {
        request: {
          defaultDir: currentProfilePath ? pathDirectory(currentProfilePath) : host.getDefaultDirectory(),
          fileName: currentProfilePath ? fileName(currentProfilePath) : "Analyse.xml",
        },
      });
      if (!path) return;
      await invoke("save_document", {
        request: { path, text: xml, encoding: "UTF-8", lineEnding: "LF" },
      });
      currentProfilePath = path;
      host.rememberProfilePath(path);
      renderRecentProfiles();
      setStatus(`已保存 Profile：${fileName(path)}`);
    } catch (error) {
      reportProfileError("保存 Profile 失败", error);
    }
  }

  function renderRecentProfiles() {
    const recent = select("recent-profile");
    const selectedPath = recent.value || currentProfilePath || "";
    recent.replaceChildren(new Option("最近 Profile", ""));
    for (const path of host.getRecentProfilePaths()) {
      const option = new Option(fileName(path), path);
      option.title = path;
      recent.appendChild(option);
    }
    recent.value = host.getRecentProfilePaths().includes(selectedPath) ? selectedPath : "";
    element<HTMLButtonElement>("recent-profile-open").disabled = recent.options.length <= 1;
  }

  function selectedProfileLoadMode() {
    return select("profile-load-mode").value as AnalyseProfileLoadMode;
  }

  function reportProfileError(message: string, error: unknown) {
    const detail = `${message}：${String(error)}`;
    setStatus(detail, true);
    host.log(detail);
  }

  async function run() {
    if (patterns.length === 0) {
      clearResult();
      setStatus("请先添加至少一个 Pattern", true);
      return;
    }
    const searchAllOpenFiles = input("all-open-files").checked;
    const documentSnapshots = searchAllOpenFiles ? host.getDocuments() : [host.getDocument()];
    if (documentSnapshots.length === 0) {
      clearResult();
      setStatus("没有可分析的打开文件", true);
      return;
    }
    if (activeRunId !== null) cancelActiveRun(false);
    const runId = ++nextRunId;
    activeRunId = runId;
    const requestedPatternRevision = patternRevision;
    setRunning(true);
    setStatus(searchAllOpenFiles
      ? `正在分析 ${documentSnapshots.length} 个打开文件…`
      : `正在分析 ${documentSnapshots[0].title}…`);
    try {
      const firstDocument = documentSnapshots[0];
      const combined: AnalyseRunResponse = {
        runId,
        documentId: firstDocument.id,
        documentRevision: firstDocument.revision,
        patternRevision: requestedPatternRevision,
        lines: [],
        totalMatches: 0,
        patternHits: [],
        patternErrors: [],
        totalLines: 0,
      };
      const combinedHits = new Map<number, number>();
      const completedDocumentIds = new Set<number>();
      const failedDocuments: string[] = [];
      let completedDocuments = 0;
      for (const documentSnapshot of documentSnapshots) {
        if (!isRunCurrent(runId, requestedPatternRevision, documentSnapshots, searchAllOpenFiles)) return;
        setStatus(`正在分析 ${documentSnapshot.title}（${completedDocuments + 1}/${documentSnapshots.length}）…`);
        const commonRequest = {
          runId,
          documentId: documentSnapshot.id,
          documentRevision: documentSnapshot.revision,
          patternRevision: requestedPatternRevision,
          patterns,
        };
        try {
          const usePath = documentSnapshot.largeFile
            && !documentSnapshot.dirty
            && Boolean(documentSnapshot.path);
          const result = usePath
            ? await invoke<AnalyseRunResponse>("run_analyse_path", {
              request: {
                ...commonRequest,
                path: documentSnapshot.path,
                expectedFileSize: documentSnapshot.fileSize,
                encoding: documentSnapshot.encoding,
                expectedDiskRevision: documentSnapshot.diskRevision,
              },
            })
            : await invoke<AnalyseRunResponse>("run_analyse", {
              request: { ...commonRequest, text: documentSnapshot.text },
            });
          if (!isCurrentResult(result, documentSnapshots, searchAllOpenFiles)) {
            await releaseResultBatch(result.resultToken);
            host.log("Analyse 已丢弃过期结果");
            return;
          }
          if (!await consumeResultBatches(
            result,
            () => isRunCurrent(runId, requestedPatternRevision, documentSnapshots, searchAllOpenFiles),
          )) return;
          for (const line of result.lines) {
            line.sourceDocumentId = documentSnapshot.id;
            line.sourceDocumentTitle = documentSnapshot.title;
            line.sourceDocumentPath = documentSnapshot.path;
          }
          combined.lines.push(...result.lines);
          combined.totalMatches += result.totalMatches;
          combined.totalLines += result.totalLines;
          for (const item of result.patternHits) {
            combinedHits.set(item.patternId, (combinedHits.get(item.patternId) ?? 0) + item.hits);
          }
          combined.patternErrors.push(...result.patternErrors.map((item) => ({
            ...item,
            message: `${documentSnapshot.title}: ${item.message}`,
          })));
          completedDocuments += 1;
          completedDocumentIds.add(documentSnapshot.id);
        } catch (error) {
          if (!isRunCurrent(runId, requestedPatternRevision, documentSnapshots, searchAllOpenFiles)) return;
          failedDocuments.push(documentSnapshot.title);
          host.log(`Analyse 跳过 ${documentSnapshot.title}：${String(error)}`);
        }
      }
      if (completedDocuments === 0) {
        setStatus(`Analyse 失败：${failedDocuments.join("、")}`, true);
        return;
      }
      combined.patternHits = [...combinedHits].map(([patternId, patternHits]) => ({
        patternId,
        hits: patternHits,
      }));
      combined.documentCount = completedDocuments;
      latestResult = combined;
      clearResultBookmarks();
      for (const documentSnapshot of documentSnapshots) {
        if (!completedDocumentIds.has(documentSnapshot.id)) continue;
        resultDocumentIds.add(documentSnapshot.id);
        const bookmarkLines = combined.lines
          .filter((line) => line.sourceDocumentId === documentSnapshot.id)
          .map((line) => line.sourceLine);
        if (bookmarkLines.length === 0) continue;
        host.setBookmarkLines(documentSnapshot.id, bookmarkLines);
      }
      hits.clear();
      errors.clear();
      for (const item of combined.patternHits) hits.set(item.patternId, item.hits);
      for (const item of combined.patternErrors) {
        const previous = errors.get(item.patternId);
        errors.set(item.patternId, previous ? `${previous}\n${item.message}` : item.message);
      }
      renderPatterns();
      host.setResultVisible(true);
      renderResult();
      window.requestAnimationFrame(() => resultEditor.layout());
      await writeBoundResult();
      setStatus(
        `${completedDocuments} 个文件，${combined.totalLines} 行，捞出 ${combined.totalMatches} 个匹配${combined.patternErrors.length ? `，${combined.patternErrors.length} 个 Pattern 错误` : ""}${failedDocuments.length ? `，跳过 ${failedDocuments.length} 个文件` : ""}`,
        combined.patternErrors.length > 0 || failedDocuments.length > 0,
      );
    } catch (error) {
      if (runId !== nextRunId) return;
      setStatus(`Analyse 失败：${String(error)}`, true);
      host.log(`Analyse 失败：${String(error)}`);
    } finally {
      if (activeRunId === runId) activeRunId = null;
      if (runId === nextRunId) setRunning(false);
    }
  }

  function pinResultSelection() {
    if (!latestResult) return;
    const indices = selectedResultLineIndices(resultEditor.getSelections() ?? [], latestResult.lines.length,
      resultEditor.getPosition()?.lineNumber ?? 1,
      latestResult.lines.map(line => (line.text.match(/\r\n|\r|\n/g)?.length ?? 0) + 1));
    const documents = new Map(host.getDocuments().map(doc => [doc.id, doc]));
    host.pinResults(indices.map(index => {
      const line = latestResult!.lines[index];
      const documentId = line.sourceDocumentId ?? latestResult!.documentId;
      const doc = documents.get(documentId);
      return { kind: "analyse", text: line.text, analysis: line,
        sources: [{ documentId, path: line.sourceDocumentPath === undefined ? doc?.path ?? null : line.sourceDocumentPath,
          fileName: line.sourceDocumentTitle || doc?.title || "未命名", line: line.sourceLine, column: 1 }] };
    }));
  }

  function isCurrentResult(
    result: AnalyseRunResponse,
    documents: AnalyseDocumentSnapshot[],
    searchAllOpenFiles: boolean,
  ) {
    const expected = documents.find((document) => document.id === result.documentId);
    return Boolean(expected)
      && result.documentRevision === expected?.revision
      && isRunCurrent(result.runId, result.patternRevision, documents, searchAllOpenFiles);
  }

  function isRunCurrent(
    runId: number,
    requestedPatternRevision: number,
    documents: AnalyseDocumentSnapshot[],
    searchAllOpenFiles: boolean,
  ) {
    if (runId !== nextRunId || requestedPatternRevision !== patternRevision) return false;
    if (!searchAllOpenFiles && host.getActiveDocumentId() !== documents[0]?.id) return false;
    const currentDocuments = host.getDocumentRevisions();
    if (searchAllOpenFiles && currentDocuments.length !== documents.length) return false;
    const currentById = new Map(currentDocuments.map((document) => [document.id, document]));
    return documents.every((document) => currentById.get(document.id)?.revision === document.revision);
  }

  async function consumeResultBatches(result: AnalyseRunResponse, isCurrent: () => boolean) {
    const resultToken = result.resultToken;
    if (!resultToken) return true;
    let offset = result.lines.length;
    try {
      while (offset < result.totalLines) {
        if (!isCurrent()) {
          await releaseResultBatch(resultToken);
          return false;
        }
        setStatus(`正在接收结果 ${offset}/${result.totalLines} 行…`);
        const chunk = await invoke<AnalyseResultChunk>("read_analyse_result_chunk", {
          request: { resultToken, offset, limit: 2_000 },
        });
        result.lines.push(...chunk.lines);
        offset = chunk.nextOffset;
        if (chunk.done) break;
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      result.resultToken = null;
      return isCurrent();
    } catch (error) {
      await releaseResultBatch(resultToken);
      throw error;
    }
  }

  async function releaseResultBatch(resultToken: string | null | undefined) {
    if (!resultToken) return;
    await invoke<boolean>("release_analyse_result", { resultToken }).catch(() => false);
  }

  function renderResult() {
    if (!latestResult) {
      clearResultModel();
      return;
    }
    const showLines = input("show-lines").checked;
    const renderedLines: string[] = [];
    resultMapping = [];
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const styleClasses = new Map<string, string>();
    const styleRules: string[] = [];
    const documentCount = latestResult.documentCount ?? new Set(
      latestResult.lines.map((line) => line.sourceDocumentId ?? latestResult?.documentId),
    ).size;
    const sourceLineDigits = String(
      latestResult.lines.reduce((maximum, line) => Math.max(maximum, line.sourceLine), 1),
    ).length;

    latestResult.lines.forEach((line, index) => {
      const prefix = resultLinePrefix(line, showLines, documentCount, sourceLineDigits);
      renderedLines.push(prefix + line.text);
      resultMapping.push({
        resultLine: index + 1,
        sourceDocumentId: line.sourceDocumentId ?? latestResult?.documentId ?? 0,
        sourceLine: line.sourceLine,
        sourceDocumentTitle: line.sourceDocumentTitle ?? "",
        matchingPatternIds: line.matchingPatternIds,
      });
      for (const segment of line.styledSegments) {
        if (segment.startByteInLine >= segment.endByteInLine) continue;
        const styleKey = JSON.stringify([
          segment.hidden,
          segment.bold,
          segment.italic,
          segment.underline,
          segment.foreground,
          segment.background,
        ]);
        let className = styleClasses.get(styleKey);
        if (!className) {
          className = `analyse-result-style-${styleClasses.size}`;
          styleClasses.set(styleKey, className);
          styleRules.push(styleRule(className, segment));
        }
        decorations.push({
          range: new monaco.Range(
            index + 1,
            prefix.length + utf16ColumnAtByte(line.text, segment.startByteInLine),
            index + 1,
            prefix.length + utf16ColumnAtByte(line.text, segment.endByteInLine),
          ),
          options: {
            inlineClassName: className,
            hoverMessage: segment.patternId
              ? { value: `Pattern ${segment.patternId}` }
              : undefined,
          },
        });
      }
    });
    styleElement.textContent = styleRules.join("\n");
    resultModel.setValue(renderedLines.join("\n"));
    resultDecorations.set(decorations);
    clearResultFind();
    renderMatchingPatterns(1);
    element("result-summary").textContent = `${documentCount} 个文件 / ${latestResult.lines.length} 行 / 捞出 ${latestResult.totalMatches} 个匹配`;
  }

  async function findResult(direction: 1 | -1) {
    if (!latestResult) return;
    const query = input("result-find-input").value;
    if (!query) {
      clearResultFind();
      return;
    }
    const signature = JSON.stringify([
      latestResult.runId,
      query,
      select("result-find-type").value,
      input("result-find-case").checked,
      input("result-find-word").checked,
      input("show-lines").checked,
    ]);
    if (signature !== resultFindSignature) {
      try {
        const found = await invoke<AnalyseResultFindMatch[]>("find_analyse_result", {
          request: {
            text: latestResult.lines.map((line) => line.text).join("\n"),
            query,
            searchType: select("result-find-type").value,
            matchCase: input("result-find-case").checked,
            wholeWord: input("result-find-word").checked,
          },
        });
        if (!latestResult || signature !== JSON.stringify([
          latestResult.runId,
          input("result-find-input").value,
          select("result-find-type").value,
          input("result-find-case").checked,
          input("result-find-word").checked,
          input("show-lines").checked,
        ])) return;
        resultFindMatches = found.map((match) => new monaco.Range(
          match.startLine,
          resultPrefixLength(match.startLine) + match.startColumn,
          match.endLine,
          resultPrefixLength(match.endLine) + match.endColumn,
        ));
        resultFindSignature = signature;
        activeResultFindIndex = direction > 0 ? -1 : 0;
      } catch (error) {
        element("result-find-summary").textContent = `查找失败：${String(error)}`;
        clearResultFindDecorations();
        return;
      }
    }
    if (resultFindMatches.length === 0) {
      activeResultFindIndex = -1;
      clearResultFindDecorations();
      element("result-find-summary").textContent = "这次没有捞到匹配";
      return;
    }
    activeResultFindIndex = (
      activeResultFindIndex + direction + resultFindMatches.length
    ) % resultFindMatches.length;
    renderResultFindDecorations();
    const active = resultFindMatches[activeResultFindIndex];
    resultEditor.setSelection(active);
    resultEditor.revealRangeInCenterIfOutsideViewport(active);
    element("result-find-summary").textContent = `${activeResultFindIndex + 1}/${resultFindMatches.length}`;
  }

  function resultPrefixLength(lineNumber: number) {
    if (!latestResult) return 0;
    const line = latestResult.lines[lineNumber - 1];
    return line ? resultLinePrefix(line, input("show-lines").checked).length : 0;
  }

  function resultLinePrefix(
    line: AnalyseLine,
    showLines: boolean,
    documentCount = latestResult
      ? latestResult.documentCount ?? new Set(
        latestResult.lines.map((item) => item.sourceDocumentId ?? latestResult?.documentId),
      ).size
      : 1,
    digits = String(
      latestResult?.lines.reduce((maximum, item) => Math.max(maximum, item.sourceLine), 1) ?? 1,
    ).length,
  ) {
    const documentPrefix = documentCount > 1 ? `[${line.sourceDocumentTitle || "未命名"}] ` : "";
    if (!showLines) return documentPrefix;
    return `${documentPrefix}${String(line.sourceLine).padStart(digits, " ")}: `;
  }

  function renderResultFindDecorations() {
    resultFindDecorations.set(resultFindMatches.map((range, index) => ({
      range,
      options: {
        inlineClassName: index === activeResultFindIndex
          ? "analyse-result-find-active"
          : "analyse-result-find-match",
      },
    })));
  }

  function clearResultFindDecorations() {
    resultFindDecorations.clear();
  }

  function clearResultFind() {
    resultFindMatches = [];
    activeResultFindIndex = -1;
    resultFindSignature = "";
    clearResultFindDecorations();
    element("result-find-summary").textContent = "";
  }

  function renderMatchingPatterns(resultLine: number) {
    const mapping = resultMapping[resultLine - 1];
    if (!mapping) {
      element("matching-patterns").textContent = "当前行无匹配 Pattern";
      return;
    }
    const labels = mapping.matchingPatternIds.map((id) => {
      const pattern = patterns.find((item) => item.id === id);
      return pattern ? `#${id} ${pattern.searchText}` : `#${id}`;
    });
    element("matching-patterns").textContent = labels.length > 0
      ? `${mapping.sourceDocumentTitle ? `${mapping.sourceDocumentTitle} · ` : ""}Matching Patterns：${labels.join("；")}`
      : "当前行无匹配 Pattern";
  }

  function syncSourceLine(sourceLine: number) {
    if (!input("scroll-sync").checked || syncingFromResult || resultMapping.length === 0) return;
    const activeDocumentId = host.getDocument().id;
    const candidates = resultMapping
      .map((mapping, index) => ({ mapping, index }))
      .filter(({ mapping }) => mapping.sourceDocumentId === activeDocumentId);
    if (candidates.length === 0) return;
    let closest = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (
        Math.abs(candidate.mapping.sourceLine - sourceLine)
        < Math.abs(closest.mapping.sourceLine - sourceLine)
      ) closest = candidate;
    }
    syncingFromSource = true;
    resultEditor.revealLineInCenterIfOutsideViewport(closest.index + 1);
    queueMicrotask(() => { syncingFromSource = false; });
  }

  async function copyResult(rich: boolean) {
    if (!latestResult) {
      setStatus("当前没有可复制的 Analyse 结果", true);
      return;
    }
    try {
      const plain = resultModel.getValue();
      if (rich && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        try {
          const payload: Record<string, Blob> = {
            "text/plain": new Blob([plain], { type: "text/plain" }),
          };
          const formats: string[] = [];
          if (clipboardSupportsMime("text/rtf")) {
            const rtf = await serializeRtf();
            payload["text/rtf"] = new Blob([rtf], { type: "text/rtf" });
            formats.push("RTF");
          }
          if (clipboardSupportsMime("text/html")) {
            const html = await serializeHtml();
            payload["text/html"] = new Blob([html], { type: "text/html" });
            formats.push("HTML");
          }
          if (formats.length === 0) throw new Error("No rich clipboard MIME is supported");
          await navigator.clipboard.write([new ClipboardItem(payload)]);
          setStatus(`已复制 Analyse 富文本结果（${formats.join(" + ")}）`);
        } catch {
          await navigator.clipboard.writeText(plain);
          setStatus("Rich Clipboard 不可用，已复制纯文本");
        }
      } else {
        await navigator.clipboard.writeText(plain);
        setStatus(rich ? "当前平台不支持 Rich Clipboard，已复制纯文本" : "已复制 Analyse 结果");
      }
    } catch (error) {
      setStatus(`复制结果失败：${String(error)}`, true);
    }
  }

  async function saveResult(rich: boolean) {
    if (!latestResult) {
      setStatus("当前没有可保存的 Analyse 结果", true);
      return;
    }
    try {
      const path = await invoke<string | null>("pick_save_path", {
        request: {
          defaultDir: host.getDefaultDirectory(),
          fileName: rich ? "Analyse-result.rtf" : "Analyse-result.txt",
        },
      });
      if (!path) return;
      const text = rich ? await serializeRtf() : resultModel.getValue();
      await saveTextFile(path, text);
      setStatus(`已保存 Analyse ${rich ? "RTF" : "文本"}结果：${fileName(path)}`);
    } catch (error) {
      setStatus(`保存结果失败：${String(error)}`, true);
    }
  }

  async function bindResult() {
    try {
      const path = await invoke<string | null>("pick_save_path", {
        request: {
          defaultDir: boundResultPath ? pathDirectory(boundResultPath) : host.getDefaultDirectory(),
          fileName: boundResultPath ? fileName(boundResultPath) : "Analyse-bound-result.txt",
        },
      });
      if (!path) return;
      boundResultPath = path;
      persistSettings();
      renderBoundResult();
      await writeBoundResult();
      setStatus(`Result 已绑定：${fileName(path)}`);
    } catch (error) {
      setStatus(`绑定 Result 失败：${String(error)}`, true);
    }
  }

  function unbindResult() {
    if (!boundResultPath) return;
    boundResultPath = null;
    persistSettings();
    renderBoundResult();
    setStatus("Result 文件绑定已解除");
  }

  async function writeBoundResult() {
    if (!boundResultPath || !latestResult) return;
    try {
      await saveTextFile(boundResultPath, resultModel.getValue());
    } catch (error) {
      const message = `更新绑定 Result 失败：${String(error)}`;
      setStatus(message, true);
      host.log(message);
    }
  }

  function saveTextFile(path: string, text: string) {
    return invoke("save_document", {
      request: { path, text, encoding: "UTF-8", lineEnding: "LF" },
    });
  }

  function serializeRtf() {
    if (!latestResult) return Promise.reject(new Error("Analyse Result is empty"));
    return invoke<string>("serialize_analyse_rtf", {
      request: {
        lines: serializableResultLines(),
        showLineNumbers: input("show-lines").checked,
        fontSize: Number(input("result-font").value) || 12,
      },
    });
  }

  function serializeHtml() {
    if (!latestResult) return Promise.reject(new Error("Analyse Result is empty"));
    return invoke<string>("serialize_analyse_html", {
      request: {
        lines: serializableResultLines(),
        showLineNumbers: input("show-lines").checked,
        fontSize: Number(input("result-font").value) || 12,
      },
    });
  }

  function serializableResultLines() {
    if (!latestResult) return [];
    const documentCount = latestResult.documentCount ?? new Set(
      latestResult.lines.map((line) => line.sourceDocumentId ?? latestResult?.documentId),
    ).size;
    if (documentCount <= 1) return latestResult.lines;
    const encoder = new TextEncoder();
    return latestResult.lines.map((line) => {
      const prefix = `[${line.sourceDocumentTitle || "未命名"}] `;
      const prefixBytes = encoder.encode(prefix).length;
      return {
        ...line,
        text: prefix + line.text,
        styledSegments: line.styledSegments.map((segment) => ({
          ...segment,
          startByteInLine: segment.startByteInLine + prefixBytes,
          endByteInLine: segment.endByteInLine + prefixBytes,
        })),
      };
    });
  }

  function applySettings() {
    const settings = host.getSettings();
    input("auto-update").checked = settings.autoUpdate;
    input("all-open-files").checked = settings.searchAllOpenFiles;
    input("show-lines").checked = settings.showLineNumbers;
    input("word-wrap").checked = settings.wordWrap;
    input("scroll-sync").checked = settings.scrollSync;
    select("enter-action").value = settings.enterAction;
    input("result-font").value = String(Math.min(24, Math.max(10, settings.fontSize || 12)));
    boundResultPath = settings.boundResultPath;
    const restoredPatterns = Array.isArray(settings.workingPatterns)
      ? settings.workingPatterns.map((pattern) => ({ ...pattern }))
      : [];
    patterns.splice(0, patterns.length, ...restoredPatterns);
    selectedPatternId = patterns[0]?.id ?? null;
    nextPatternId = Math.max(0, ...patterns.map((pattern) => pattern.id)) + 1;
    writeDraft(patterns[0] ?? defaultPattern(0));
    renderPatterns();
    resultEditor.updateOptions({
      wordWrap: settings.wordWrap ? "on" : "off",
      fontSize: Number(input("result-font").value),
      lineHeight: Math.round(Number(input("result-font").value) * 1.6),
    });
    renderBoundResult();
  }

  function persistSettings() {
    host.updateSettings({
      autoUpdate: input("auto-update").checked,
      searchAllOpenFiles: input("all-open-files").checked,
      showLineNumbers: input("show-lines").checked,
      wordWrap: input("word-wrap").checked,
      fontSize: Number(input("result-font").value) || 12,
      scrollSync: input("scroll-sync").checked,
      boundResultPath,
      enterAction: select("enter-action").value as AnalyseEnterAction,
      workingPatterns: patterns.map((pattern) => ({ ...pattern })),
    });
  }

  function renderBoundResult() {
    element("bound-result").textContent = boundResultPath
      ? `绑定：${fileName(boundResultPath)}`
      : "未绑定结果文件";
    element<HTMLButtonElement>("unbind-result").disabled = !boundResultPath;
  }

  function clearResultState() {
    if (activeRunId !== null) cancelActiveRun(false);
    else nextRunId += 1;
    hits.clear();
    errors.clear();
    clearResult(true);
    renderPatterns();
    setStatus("Analyse 结果已清除");
  }

  function clearResult(updateBookmarks = false) {
    if (updateBookmarks) clearResultBookmarks();
    latestResult = null;
    clearResultModel();
    host.setResultVisible(false);
  }

  function clearResultBookmarks() {
    for (const documentId of resultDocumentIds) host.setBookmarkLines(documentId, []);
    resultDocumentIds.clear();
  }

  function invalidateResult(autoRun = true) {
    patternRevision += 1;
    if (activeRunId !== null) cancelActiveRun(false);
    else nextRunId += 1;
    hits.clear();
    errors.clear();
    clearResult(true);
    if (autoRun) scheduleAutoRun();
  }

  function clearResultModel() {
    resultMapping = [];
    styleElement.textContent = "";
    resultDecorations.clear();
    clearResultFind();
    resultModel.setValue("");
    element("result-summary").textContent = "等待分析";
    element("matching-patterns").textContent = "当前行无匹配 Pattern";
  }

  function setRunning(running: boolean) {
    element<HTMLButtonElement>("run").disabled = running;
    element("run").classList.toggle("running", running);
    element("run").innerHTML = runButtonContent(running);
    element<HTMLButtonElement>("cancel").disabled = !running;
  }

  function cancelActiveRun(updateStatus = true) {
    const runId = activeRunId;
    if (runId === null) return;
    activeRunId = null;
    nextRunId += 1;
    setRunning(false);
    void invoke<boolean>("cancel_analyse", { runId }).catch(() => false);
    if (updateStatus) setStatus("Analyse 已取消");
  }

  function scheduleAutoRun() {
    window.clearTimeout(autoRunTimer);
    if (!input("auto-update").checked || patterns.length === 0) return;
    autoRunTimer = window.setTimeout(() => void run(), 300);
  }

  function notifyDocumentChanged(documentId: number) {
    if (!input("all-open-files").checked && documentId !== host.getDocument().id) return;
    if (resultDocumentIds.has(documentId)) clearResult(true);
    scheduleAutoRun();
  }

  function setStatus(message: string, error = false) {
    const status = element("status");
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function syncDocument() {
    const current = host.getDocument();
    const openDocumentIds = new Set(host.getDocumentRevisions().map((document) => document.id));
    const closedResultDocumentIds = [...resultDocumentIds]
      .filter((documentId) => !openDocumentIds.has(documentId));
    for (const documentId of closedResultDocumentIds) {
      resultDocumentIds.delete(documentId);
      host.setBookmarkLines(documentId, []);
    }
    const switchedSingleDocument = !input("all-open-files").checked
      && resultDocumentIds.size > 0
      && !resultDocumentIds.has(current.id);
    if (switchedSingleDocument) {
      if (activeRunId !== null) cancelActiveRun(false);
      clearResult(true);
      setStatus(`已切换到 ${current.title}，运行以生成结果`);
      scheduleAutoRun();
    } else if (closedResultDocumentIds.length > 0 && latestResult) {
      setStatus("来源文档已关闭，当前 Analyse 结果已保留；再次运行可刷新结果");
      scheduleAutoRun();
    }
    resultEditor.layout();
  }

  return {
    addSelectionAsPattern,
    cancel: cancelActiveRun,
    clearPatterns,
    focusOptions: () => input("search-text").focus(),
    focusResult: () => {
      if (latestResult) host.setResultVisible(true);
      resultEditor.focus();
    },
    layout: () => resultEditor.layout(),
    loadProfile,
    loadProfilePath,
    notifyDocumentChanged,
    run,
    saveProfile,
    syncDocument,
    syncRecentProfiles: renderRecentProfiles,
    syncSettings: applySettings,
    syncSourceLine,
  };
}

function defaultPattern(id: number): AnalysePattern {
  return {
    id,
    orderNum: "",
    enabled: true,
    searchText: "",
    searchType: "normal",
    matchCase: false,
    wholeWord: false,
    selection: "line",
    hide: false,
    bold: false,
    italic: false,
    underline: false,
    foreground: DEFAULT_FOREGROUND,
    background: DEFAULT_BACKGROUND,
    comment: "",
    group: "",
  };
}

function compareOrder(left: string, right: string) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (left.trim() && right.trim() && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right, undefined, { numeric: true });
}

function searchTypeLabel(type: AnalyseSearchType) {
  switch (type) {
    case "escaped": return "扩展";
    case "regex": return "正则";
    case "regexMultiline": return "跨行正则";
    default: return "普通";
  }
}

function utf16ColumnAtByte(text: string, byteOffset: number) {
  const encoder = new TextEncoder();
  let bytes = 0;
  let utf16Units = 0;
  for (const character of text) {
    const nextBytes = bytes + encoder.encode(character).length;
    if (nextBytes > byteOffset) break;
    bytes = nextBytes;
    utf16Units += character.length;
  }
  return utf16Units + 1;
}

function styleRule(className: string, segment: StyledSegment) {
  const foreground = validColor(segment.foreground) ? segment.foreground : "inherit";
  const background = validColor(segment.background) ? segment.background : "transparent";
  const decorations = segment.underline ? "underline" : "none";
  const hidden = segment.hidden ? "opacity:0;" : "";
  return `.${className}{color:${foreground}!important;background:${background}!important;font-weight:${segment.bold ? 700 : 400};font-style:${segment.italic ? "italic" : "normal"};text-decoration:${decorations};${hidden}}`;
}

function validColor(value: string) {
  return /^#[0-9A-F]{6}$/i.test(value);
}

function runButtonContent(running: boolean) {
  const icon = running
    ? '<svg class="analyse-run-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>'
    : '<svg class="analyse-run-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" /></svg>';
  return `${icon}<span>${running ? "分析中…" : "运行"}</span>`;
}

function clipboardSupportsMime(mime: string) {
  const supports = (ClipboardItem as typeof ClipboardItem & {
    supports?: (type: string) => boolean;
  }).supports;
  return typeof supports === "function" ? supports.call(ClipboardItem, mime) : mime === "text/html";
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function pathDirectory(path: string) {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (index === 2 && path[1] === ":") return path.slice(0, 3);
  return index > 0 ? path.slice(0, index) : null;
}

function profileModeLabel(mode: AnalyseProfileLoadMode) {
  if (mode === "append") return "已追加";
  if (mode === "prepend") return "已前置";
  return "已加载";
}

function panelMarkup() {
  return `
    <div class="analyse-panel">
      <header class="analyse-panel-head">
        <div><strong>Analyse</strong><span data-analyse-role="pattern-count">0 个 Pattern</span></div>
        <div>
          <label class="analyse-auto-update"><input data-analyse-role="all-open-files" type="checkbox" />全部打开文件</label>
          <label class="analyse-auto-update"><input data-analyse-role="auto-update" type="checkbox" />自动</label>
          <button class="primary analyse-run-button" data-analyse-role="run" type="button">${runButtonContent(false)}</button>
          <button data-analyse-role="cancel" type="button" disabled>取消</button>
          <button data-analyse-role="clear-result" type="button">清除结果</button>
        </div>
      </header>
      <section class="analyse-profile-bar" aria-label="Analyse Profile">
        <select data-analyse-role="profile-load-mode" aria-label="Profile 加载方式"><option value="replace">替换</option><option value="append">追加</option><option value="prepend">前置</option></select>
        <button data-analyse-role="load-profile" type="button">加载 XML</button>
        <button data-analyse-role="save-profile" type="button">保存 XML</button>
        <select data-analyse-role="recent-profile" aria-label="最近 Profile"></select>
        <button data-analyse-role="recent-profile-open" type="button">打开最近</button>
      </section>
      <section class="analyse-draft" aria-label="Pattern 配置">
        <label class="analyse-search-text"><span>Search Text</span><input data-analyse-role="search-text" autocomplete="off" placeholder="输入文本、扩展表达式或正则" /></label>
        <div class="analyse-draft-grid">
          <label><span>类型</span><select data-analyse-role="search-type"><option value="normal">普通</option><option value="escaped">扩展</option><option value="regex">正则</option><option value="regexMultiline">跨行正则</option></select></label>
          <label><span>选择</span><select data-analyse-role="selection"><option value="line">整行</option><option value="text">文本</option></select></label>
          <label><span>Order</span><input data-analyse-role="order" /></label>
          <label><span>Group</span><input data-analyse-role="group" /></label>
          <label><span>Comment</span><input data-analyse-role="comment" /></label>
          <label><span>Enter</span><select data-analyse-role="enter-action"><option value="update">更新当前行</option><option value="add">新增一行</option><option value="search">仅搜索</option></select></label>
          <label><span>前景色</span><input data-analyse-role="foreground" type="color" value="${DEFAULT_FOREGROUND}" /></label>
          <label><span>背景色</span><input data-analyse-role="background" type="color" value="${DEFAULT_BACKGROUND}" /></label>
        </div>
        <div class="analyse-flags">
          <label><input data-analyse-role="enabled" type="checkbox" checked />启用</label>
          <label><input data-analyse-role="match-case" type="checkbox" />区分大小写</label>
          <label><input data-analyse-role="whole-word" type="checkbox" />全词</label>
          <label><input data-analyse-role="hide" type="checkbox" />隐藏</label>
          <label><input data-analyse-role="bold" type="checkbox" />粗体</label>
          <label><input data-analyse-role="italic" type="checkbox" />斜体</label>
          <label><input data-analyse-role="underline" type="checkbox" />下划线</label>
        </div>
        <div class="analyse-actions">
          <button class="primary" data-analyse-role="add" type="button">添加</button>
          <button data-analyse-role="add-selection" type="button">添加源选区</button>
          <button data-analyse-role="update" type="button">更新</button>
          <button data-analyse-role="delete" type="button">删除</button>
          <button data-analyse-role="clear-patterns" type="button">清空 Pattern</button>
          <button data-analyse-role="up" type="button">上移</button>
          <button data-analyse-role="down" type="button">下移</button>
          <button data-analyse-role="sort" type="button">按 Order 排序</button>
          <button data-analyse-role="enable-all" type="button">全部启用</button>
          <button data-analyse-role="disable-all" type="button">全部禁用</button>
          <button data-analyse-role="enable-group" type="button">启用当前组</button>
          <button data-analyse-role="disable-group" type="button">禁用当前组</button>
        </div>
      </section>
      <section class="analyse-patterns">
        <table>
          <thead><tr><th>启用</th><th>Order</th><th>Search Text</th><th>类型</th><th>Group</th><th>Hits</th><th>状态</th></tr></thead>
          <tbody data-analyse-role="pattern-list"></tbody>
        </table>
      </section>
      <footer class="analyse-status" data-analyse-role="status" aria-live="polite"></footer>
    </div>
  `;
}

function resultMarkup() {
  return `
      <section class="analyse-result">
        <header>
          <div><strong>结果</strong><span data-analyse-role="result-summary">等待分析</span></div>
          <div class="analyse-result-options">
            <label><input data-analyse-role="show-lines" type="checkbox" checked />源行号</label>
            <label><input data-analyse-role="word-wrap" type="checkbox" />自动换行</label>
            <label><input data-analyse-role="scroll-sync" type="checkbox" />滚动同步</label>
            <label>字号 <input data-analyse-role="result-font" class="analyse-font-size" type="number" min="10" max="24" value="12" /></label>
          </div>
        </header>
        <div class="analyse-result-find">
          <input data-analyse-role="result-find-input" aria-label="在 Analyse 结果中查找" placeholder="在结果中查找" />
          <select data-analyse-role="result-find-type" aria-label="结果查找类型"><option value="normal">普通</option><option value="escaped">扩展</option><option value="regex">正则</option><option value="regexMultiline">跨行正则</option></select>
          <label><input data-analyse-role="result-find-case" type="checkbox" />Aa</label>
          <label><input data-analyse-role="result-find-word" type="checkbox" />词</label>
          <button data-analyse-role="result-find-previous" type="button" title="上一个">↑</button>
          <button data-analyse-role="result-find-next" type="button" title="下一个">↓</button>
          <span data-analyse-role="result-find-summary"></span>
        </div>
        <div class="analyse-result-actions">
          <button data-analyse-role="pin-result" type="button" title="支持多行和多选区；无选区时固定当前结果行">固定选中行</button>
          <button data-analyse-role="copy-result" type="button">复制</button>
          <button data-analyse-role="copy-result-rtf" type="button">复制富文本</button>
          <button data-analyse-role="save-result" type="button">保存文本</button>
          <button data-analyse-role="save-result-rtf" type="button">保存 RTF</button>
          <button data-analyse-role="bind-result" type="button">绑定文件</button>
          <button data-analyse-role="unbind-result" type="button">解绑</button>
          <span data-analyse-role="bound-result">未绑定结果文件</span>
        </div>
        <div class="analyse-result-editor" data-analyse-role="result-editor"></div>
        <div class="analyse-matching-patterns" data-analyse-role="matching-patterns">当前行无匹配 Pattern</div>
      </section>
  `;
}
