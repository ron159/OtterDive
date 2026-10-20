import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "createUntitledDocument", "createUntitledMarkdownDocument", "createDefaultUntitledDocument",
  "newDocument", "newMarkdownDocument", "createDraftDocument", "rememberClosedDocument", "reopenClosedDocument",
  "updateStartupDocumentType", "nextUntitledTitle", "documentText", "activeDocument",
  "openDocument", "openPath", "addOrReplaceDocument", "withBusy", "restoredDocumentOrigin", "showOpenFailures",
  "restoreSession", "isDoubleClickDocumentType", "closeDocument", "closeWorkspace", "draftDocumentSnapshots", "ensureDraftId",
]);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(ast)).join("\n");
const js = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const navigationJs = ts.transpileModule(fs.readFileSync(new URL("../src/markdownNavigation.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/^export /gm, "");
const noop = () => {};

test("startup restores the active Markdown draft reading anchor from the saved session", async () => {
  const location = { mode: "reading", line: 42, column: 1, cursor: null, scroll: { headingIndex: 3, offsetPx: 80, fraction: 0.65, sectionFraction: 0.4 } };
  const h = harness({ markdownEditMode: "reading", activeDraftId: "reading-draft",
    draftDocuments: [{ id: "reading-draft", creationIntent: "explicit", title: "long.md", text: "# long\n\nbody", language: "markdown" }],
    markdownLocations: { "reading-draft": location } });
  await h.context.restoreSession(h.initial);
  assert.equal(h.context.restoredReading.length, 1);
  assert.equal(h.context.restoredReading[0].id, h.state.activeId);
  assert.equal(h.context.restoredReading[0].location.scroll.sectionFraction, 0.4);
  assert.equal(h.logs.some(message => message.includes("会话恢复失败")), false, JSON.stringify(h.logs));
});

function harness(snapshot = {}, options = {}) {
  let nextId = 1;
  const disposed = [], logs = [];
  const state = {
    documents: [], activeId: 0, doubleClickDocumentType: "txt", workbench: {},
    themePreference: "system", collapsedDirs: new Set(),
  };
  const context = {
    busyDepth: 0, editorBusyDepth: 0, setBusy: message => { state.busyMessage = message; },
    readPaths: [], sessionSaves: [], alerts: [], showAlert: async prompt => { context.alerts.push(prompt); },
    Blob, state, performance, SESSION_KEY: "session", analysePanel: null, markdownLocations: {}, restoredReading: [],
    restoreMarkdownLocation: async (doc, location) => context.restoredReading.push({ id: doc.id, location }),
    encodings: ["UTF-8"], createDraftId: () => `generated-${nextId}`, closedDocuments: [],
    DEFAULT_ANALYSE_SETTINGS: {}, DEFAULT_BOTTOM_RESULTS_HEIGHT: 200, DEFAULT_EXPLORER_WIDTH: 240,
    $: () => ({ classList: { toggle: noop }, value: "" }),
    editor: { setModel: noop, saveViewState: () => ({}), restoreViewState: noop },
    window: { requestAnimationFrame: noop, setTimeout: noop },
    localStorage: { getItem: () => null },
    createDocument(dto, options = {}) {
      const doc = { ...dto, id: nextId++, draftId: options.draftId ?? `draft-${nextId}`, dirty: false, savedText: dto.text, ...options };
      doc.model = { getValue: () => doc.text, dispose: () => disposed.push(doc.id) };
      return doc;
    },
    ensureDocumentModel: doc => doc.model,
    invoke: async (command, args) => {
      if (command === "pick_file_path") return options.pickPath ?? null;
      if (command === "open_path") {
        context.readPaths.push(args.path);
        return options.read ? options.read(args.path) : Promise.reject(new Error("file unavailable"));
      }
      if (command === "load_session") {
        options.beforeRestore?.(state);
        return snapshot === null ? null : JSON.stringify(snapshot);
      }
      throw new Error("file unavailable");
    },
    startOpenPerformance: () => ({ startedAt: performance.now() }),
    finishOpenPerformance: () => ({ durationMs: 0, longTaskCount: 0, longTaskDurationMs: 0 }),
    uniquePaths: paths => paths, uniquePathsForOpen: paths => paths, normalizePathForCompare: path => path,
    normalizeWorkbenchPreferences: value => value ?? {}, normalizeThemeOverrides: () => ({}),
    normalizeFontMode: (_value, fallback) => fallback, normalizeFontStack: (_value, fallback) => fallback,
    normalizeAutoSaveDelaySeconds: () => 2, normalizeKeybindingOverrides: () => ({}), normalizeBookmarkSnapshot: () => ({}),
    isMarkdownEditMode: () => false, isMarkdownContentWidth: () => false, isShellFontPreset: () => false,
    isEditorFontPreset: () => false, isKeymapProfile: () => false, isThemePreference: () => false,
    restoreOutlinePreferences: () => ({}), resolveThemeDark: () => false,
    documentSessionKey: doc => doc.draftId,
    loadPathDtos: async paths => Promise.all(paths.map(async path => {
      try { return { value: await context.invoke("open_path", { path }) }; }
      catch (error) { return { error }; }
    })),
    preferredDialogDirectory: () => "/", fileNameFromPath: path => path.split("/").pop(),
    rememberRecentPath: noop, applyDocumentDto: (doc, dto) => Object.assign(doc, dto),
    applyRestoredDocumentMetadata: noop,
    writingStatsCache: new Map(), markdownSessions: new Map(),
    confirmDocumentCanClose: async () => true, isWorkspaceFindView: () => false,
    activateDocument: id => { state.activeId = id; }, log: message => logs.push(message),
  };
  for (const name of [
    "syncWorkbenchSettings", "setRightSidebarWidth", "setBottomResultsHeight", "applyExplorerWidth",
    "applyMarkdownPreviewWidth", "applyShellFontSettings", "applyEditorSettings", "applyMarkdownContentWidth",
    "applySearchSnapshot", "setFindView", "persistThemePreference", "applyResolvedTheme", "applyEditorPerformanceProfile",
    "renderAll", "markAppReady", "renderMarkdownSurface", "restoreWorkspaceFromSnapshot", "restoreDocumentOrder",
    "waitForNextPaint", "scheduleLanguageDetection", "scheduleAutoSave", "restoreEditorSurface", "requestEditorLayout",
    "discardRecovery", "closeSideEditorFor", "cancelAutoSave", "disposeMarkdownEditor", "rememberMarkdownLocation",
    "cancelDocumentSizeUpdate", "scheduleSessionSave", "resetSearchResults", "attachEditorModel", "renderSettingsMenu",
  ]) context[name] = noop;
  context.scheduleSessionSave = () => context.sessionSaves.push(state.documents.flatMap(doc => doc.path ? [doc.path] : []));
  vm.createContext(context);
  vm.runInContext(navigationJs, context);
  vm.runInContext(js, context);
  const initial = context.createDefaultUntitledDocument();
  state.documents.push(initial);
  state.activeId = initial.id;
  return { context, state, initial, disposed, logs };
}

for (const [preference, extension, language] of [["txt", "txt", "plaintext"], ["md", "md", "markdown"]]) {
  test(`startup uses the saved ${preference} preference when the session contains no documents`, async () => {
    const h = harness({ doubleClickDocumentType: preference });
    await h.context.restoreSession(h.initial);
    assert.equal(h.state.documents.length, 1);
    assert.equal(h.state.documents[0].title, `Untitled-1.${extension}`);
    assert.equal(h.state.documents[0].language, language);
    assert.equal(h.state.activeId, h.state.documents[0].id);
    assert.equal(h.logs.some(message => message.includes("会话恢复失败")), false, JSON.stringify(h.logs));
  });

  test(`closing the last document uses the ${preference} preference`, async () => {
    const h = harness();
    h.state.doubleClickDocumentType = preference;
    assert.equal(await h.context.closeDocument(h.initial.id), true);
    assert.equal(h.state.documents.length, 1);
    assert.equal(h.state.documents[0].language, language);
    assert.equal(h.state.activeId, h.state.documents[0].id);
  });

  test(`closing a workspace with no remaining files uses the ${preference} preference`, async () => {
    const h = harness();
    h.state.doubleClickDocumentType = preference;
    h.state.workspace = { name: "workspace" };
    h.initial.origin = "workspace";
    await h.context.closeWorkspace();
    assert.equal(h.state.documents.length, 1);
    assert.equal(h.state.documents[0].language, language);
    assert.equal(h.state.activeId, h.state.documents[0].id);
  });
}

test("a first launch without saved settings creates a plain text document", async () => {
  const h = harness(null);
  await h.context.restoreSession(h.initial);
  assert.equal(h.state.documents[0], h.initial);
  assert.equal(h.initial.language, "plaintext");
});

test("unavailable session files fall back to the saved Markdown preference", async () => {
  const h = harness({ doubleClickDocumentType: "md", openFiles: ["/missing.txt"], activePath: "/missing.txt" });
  await h.context.restoreSession(h.initial);
  assert.equal(h.state.documents.length, 1);
  assert.equal(h.state.documents[0].language, "markdown");
  assert.equal(h.logs.some(message => message.includes("会话恢复失败")), false, JSON.stringify(h.logs));
});

test("restoring multiple same-named empty drafts removes only the actual startup placeholder", async () => {
  const h = harness({
    doubleClickDocumentType: "md", activeDraftId: "saved-draft",
    draftDocuments: [
      { id: "saved-draft", title: "Untitled-1.txt", language: "plaintext", text: "" },
      { id: "other-draft", title: "Untitled-1.md", language: "markdown", text: "" },
    ],
  });
  await h.context.restoreSession(h.initial);
  assert.equal(h.state.documents.length, 2);
  assert.equal(h.state.documents[0].draftId, "saved-draft");
  assert.equal(h.state.documents[0].language, "plaintext");
  assert.equal(h.state.documents[1].draftId, "other-draft");
  assert.equal(h.state.documents[1].title, "Untitled-1.md");
  assert.equal(h.state.activeId, h.state.documents[0].id);
  assert.equal(h.logs.some(message => message.includes("会话恢复失败")), false, JSON.stringify(h.logs));
});

test("changing the default to Markdown persists through an untouched initial TXT draft and restart", async () => {
  const before = harness();
  before.state.doubleClickDocumentType = "md";
  const snapshot = {
    doubleClickDocumentType: before.state.doubleClickDocumentType,
    activeDraftId: before.initial.draftId,
    draftDocuments: JSON.parse(JSON.stringify(before.context.draftDocumentSnapshots())),
  };
  const after = harness(snapshot);
  await after.context.restoreSession(after.initial);
  assert.equal(after.state.documents.length, 1);
  assert.equal(after.state.documents[0].draftId, before.initial.draftId);
  assert.equal(after.state.documents[0].title, "Untitled-1.md");
  assert.equal(after.state.documents[0].language, "markdown");
  assert.equal(after.state.activeId, after.state.documents[0].id);
  assert.equal(after.logs.some(message => message.includes("会话恢复失败")), false);
});

test("changing the default back to TXT converts a lone untouched automatic Markdown draft", async () => {
  const h = harness({
    doubleClickDocumentType: "txt", activeDraftId: "saved-md",
    draftDocuments: [{ id: "saved-md", title: "Untitled-3.md", language: "markdown", text: "", savedText: "", dirty: false }],
  });
  await h.context.restoreSession(h.initial);
  assert.equal(h.state.documents.length, 1);
  assert.equal(h.state.documents[0].draftId, "saved-md");
  assert.equal(h.state.documents[0].title, "Untitled-3.txt");
  assert.equal(h.state.documents[0].language, "plaintext");
});

for (const [creation, preference, extension, language] of [
  ["newMarkdownDocument", "txt", "md", "markdown"],
  ["newDocument", "md", "txt", "plaintext"],
]) {
  test(`an explicitly created blank ${extension} draft keeps its type across restarts`, async () => {
    const before = harness();
    before.state.doubleClickDocumentType = preference;
    before.context[creation]();
    const explicit = before.context.activeDocument();
    before.state.documents = [explicit];
    assert.equal(explicit.creationIntent, "explicit");
    let current = before;
    for (let restart = 0; restart < 2; restart++) {
      const snapshot = {
        doubleClickDocumentType: preference,
        activeDraftId: explicit.draftId,
        draftDocuments: JSON.parse(JSON.stringify(current.context.draftDocumentSnapshots())),
      };
      const after = harness(snapshot);
      await after.context.restoreSession(after.initial);
      assert.equal(after.state.documents.length, 1);
      assert.equal(after.state.documents[0].draftId, explicit.draftId);
      assert.equal(after.state.documents[0].title, explicit.title);
      assert.equal(after.state.documents[0].language, language);
      assert.equal(after.state.documents[0].creationIntent, "explicit");
      assert.equal(after.logs.some(message => message.includes("会话恢复失败")), false);
      current = after;
    }
  });
}

test("automatic blank drafts persist their intent and follow either new default", async () => {
  for (const [previous, preference, language] of [["txt", "md", "markdown"], ["md", "txt", "plaintext"]]) {
    const before = harness();
    before.state.doubleClickDocumentType = previous;
    const automatic = before.context.createDefaultUntitledDocument();
    before.state.documents = [automatic];
    assert.equal(automatic.creationIntent, "default");
    const after = harness({
      doubleClickDocumentType: preference,
      draftDocuments: JSON.parse(JSON.stringify(before.context.draftDocumentSnapshots())),
    });
    await after.context.restoreSession(after.initial);
    assert.equal(after.state.documents.length, 1);
    assert.equal(after.state.documents[0].language, language);
    assert.equal(after.state.documents[0].creationIntent, "default");
  }
});

test("closing and reopening an explicit draft preserves its creation intent", async () => {
  const h = harness();
  h.context.newMarkdownDocument();
  const explicit = h.context.activeDocument();
  await h.context.closeDocument(explicit.id);
  await h.context.reopenClosedDocument();
  assert.equal(h.context.activeDocument().creationIntent, "explicit");
  assert.equal(h.context.activeDocument().language, "markdown");
});

test("saved content, edits, custom titles, explicit languages and file sessions keep their draft type", async () => {
  for (const [changes, session] of [
    [{ text: "Keep this text" }, {}],
    [{ dirty: true }, {}],
    [{ savedText: "Previously saved text" }, {}],
    [{ title: "notes.txt" }, {}],
    [{ languageOverride: "plaintext" }, {}],
    [{ language: "javascript" }, {}],
    [{}, { documentLanguageOverrides: { "draft:saved-draft": "plaintext" } }],
    [{}, { openFiles: ["/file.txt"] }],
  ]) {
    for (const creationIntent of [undefined, "default"]) {
      const draft = { id: "saved-draft", title: "Untitled-1.txt", language: "plaintext", text: "", savedText: "", dirty: false, creationIntent, ...changes };
      const h = harness({ doubleClickDocumentType: "md", activeDraftId: draft.id, draftDocuments: [draft], ...session });
      await h.context.restoreSession(h.initial);
      assert.equal(h.state.documents.length, 1);
      assert.equal(h.state.documents[0].draftId, draft.id);
      assert.equal(h.state.documents[0].title, draft.title);
      assert.equal(h.state.documents[0].language, draft.language);
      assert.equal(h.state.documents[0].text, draft.text);
      assert.equal(h.logs.some(message => message.includes("会话恢复失败")), false, JSON.stringify(h.logs));
    }
  }
});

test("edits made while the session loads are never replaced by the default type", async () => {
  for (const changes of [{ dirty: true, text: "typed text" }, { dirty: false, text: "typed text" }, { path: "/saved.txt" }, { languageOverride: "plaintext" }]) {
    const h = harness({ doubleClickDocumentType: "md" }, { beforeRestore: state => Object.assign(state.documents[0], changes) });
    await h.context.restoreSession(h.initial);
    assert.equal(h.state.documents[0], h.initial);
    assert.equal(h.disposed.includes(h.initial.id), false);
    assert.equal(h.logs.some(message => message.includes("会话恢复失败")), false, JSON.stringify(h.logs));
  }
});

test("a closed startup placeholder cannot replace a new document", () => {
  const h = harness();
  const newer = h.context.createUntitledDocument();
  h.state.documents = [newer];
  h.state.activeId = newer.id;
  h.state.doubleClickDocumentType = "md";
  h.context.updateStartupDocumentType(h.initial);
  assert.equal(h.state.documents[0], newer);
  assert.equal(h.disposed.length, 0);
});

function textDto(path) {
  return { path, title: path.split("/").pop(), text: "ordinary text\n", encoding: "UTF-8",
    language: "plaintext", fileSize: 14, readOnly: false, largeFile: false };
}

test("cancelling the file picker preserves every tab and starts no read", async () => {
  const h = harness();
  await h.context.openDocument();
  assert.equal(h.state.documents.length, 1);
  assert.equal(h.state.documents[0], h.initial);
  assert.equal(h.context.readPaths.length, 0);
  assert.equal(h.context.busyDepth, 0);
});

test("ordinary text opens once on repeated requests and can be closed", async () => {
  const h = harness({}, { read: async path => textDto(path) });
  await h.context.openPath("/plain.txt");
  await h.context.openPath("/plain.txt");
  assert.equal(h.context.readPaths.length, 1);
  const doc = h.state.documents.find(doc => doc.path === "/plain.txt");
  assert.equal(doc.text, "ordinary text\n");
  doc.readOnly = true; // Read-only protection must never prevent closing the tab.
  assert.equal(await h.context.closeDocument(doc.id), true);
  assert.equal(h.state.documents.some(doc => doc.path === "/plain.txt"), false);
  assert.ok(h.disposed.includes(doc.id));
});

test("closing a tab stays available during a pending rejected open and busy state clears", async () => {
  let rejectRead;
  const h = harness({}, { read: () => new Promise((_, reject) => { rejectRead = reject; }) });
  const opening = h.context.openPath("/archive.zip");
  assert.equal(h.context.busyDepth, 1);
  assert.equal(h.context.editorBusyDepth, 0);
  assert.equal(await h.context.closeDocument(h.initial.id), true);
  rejectRead(new Error("ZIP or binary file rejected"));
  await assert.rejects(opening, /binary/);
  assert.equal(h.context.busyDepth, 0);
  assert.equal(h.context.editorBusyDepth, 0);
  assert.equal(h.state.busyMessage, "");
  assert.equal(h.state.documents.some(doc => doc.path === "/archive.zip"), false);
  assert.equal(h.context.alerts.length, 1);
  assert.match(h.context.alerts[0].body, /archive.zip.*binary/);
});

test("repeated rejected opens leave no phantom tab and preserve existing content", async () => {
  const h = harness({}, { read: async () => { throw new Error("binary file rejected"); } });
  h.initial.text = "unsaved content";
  h.initial.dirty = true;
  for (let i = 0; i < 2; i++) await assert.rejects(h.context.openPath("/bad.zip"), /binary/);
  assert.equal(h.state.documents.length, 1);
  assert.equal(h.initial.text, "unsaved content");
  assert.equal(h.initial.dirty, true);
  assert.equal(h.context.busyDepth, 0);
});

test("session restore isolates ZIP and oversize errors and only persists usable tabs", async () => {
  const read = async path => {
    if (path !== "/good.txt") throw new Error(path.endsWith("zip") ? "binary" : "32 MiB limit");
    return textDto(path);
  };
  const h = harness({ openFiles: ["/bad.zip", "/good.txt", "/huge.log"], activePath: "/bad.zip" }, { read });
  await h.context.restoreSession(h.initial);
  assert.equal(h.logs.some(message => message.includes("会话恢复失败")), false, JSON.stringify(h.logs));
  assert.deepEqual(Array.from(h.state.documents).flatMap(doc => doc.path ? [doc.path] : []), ["/good.txt"]);
  assert.deepEqual(Array.from(h.context.readPaths), ["/bad.zip", "/good.txt", "/huge.log"]);
  const savedPaths = Array.from(h.context.sessionSaves.at(-1));
  assert.deepEqual(savedPaths, ["/good.txt"]);
  const next = harness({ openFiles: savedPaths, activePath: "/good.txt" }, { read });
  await next.context.restoreSession(next.initial);
  assert.deepEqual(Array.from(next.context.readPaths), ["/good.txt"]);
});
