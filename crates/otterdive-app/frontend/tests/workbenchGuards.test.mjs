import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
function harness(names, globals) {
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join("\n")
    .replace('await import("./workbenchPanels")', 'await Promise.resolve({ createSideEditor: globalThis.createSideEditor })');
  const context = vm.createContext({ Blob, ...globals });
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}
const noop = () => {};
test("keeping a deleted clean document schedules recovery after marking it dirty", async () => {
  const doc = { id: 1, title: "deleted.txt", dirty: false, readOnly: false };
  let persisted;
  const context = harness(["handleMissingDocument"], {
    state: { documents: [doc], missingFileBehavior: "keep" }, syncMarkdownModelFromEditor: noop, cancelAutoSave: noop, renderChrome: noop, scheduleSessionSave: noop, log: noop,
    scheduleRecovery(value) { persisted = { dirty: value.dirty, missing: value.externalRevision }; },
  });
  await context.handleMissingDocument(doc);
  assert.deepEqual(persisted, { dirty: true, missing: "missing" });
});
test("a successfully closed missing document does not recreate recovery", async () => {
  const doc = { id: 1 };
  const context = harness(["handleMissingDocument"], {
    state: { documents: [doc], missingFileBehavior: "close" }, syncMarkdownModelFromEditor: noop, cancelAutoSave: noop,
    closeDocument: async () => true, scheduleRecovery() { assert.fail("closed document scheduled recovery"); },
  });
  await context.handleMissingDocument(doc);
});
test("reading mode rejects current replacement before touching its model", () => {
  const context = harness(["currentReplaceContext"], {
    $: id => ({ value: id === "findInput" ? "source" : "replacement" }), activeDocument: () => ({ readOnly: false }), isReadingDocument: () => true, log: noop,
    ensureDocumentModel() { assert.fail("readonly model was reached"); },
  });
  assert.equal(context.currentReplaceContext(), null);
});
test("replace-all skips reading Markdown while editing eligible text documents", () => {
  const markdown = { id: 1 }, plain = { id: 2 }, readOnly = { id: 3, readOnly: true };
  const edited = [];
  const context = harness(["replaceOpenDocuments"], {
    monaco: { editor: { EndOfLinePreference: { LF: 1 } } },
    state: { documents: [markdown, plain, readOnly] }, $: id => ({ value: id === "findInput" ? "source" : "replacement", checked: false }),
    currentSearchPatternError: () => "", setCurrentFindError: noop, commitSearchHistory: noop, commitReplaceHistory: noop,
    activeDocument: () => markdown, syncMarkdownModelFromEditor: noop, isReadingDocument: doc => doc.id === 1,
    getSearchMode: () => "literal", editorSearchQuery: value => value, matchAllowed: () => true, replacementForMatch: () => "replacement", findOpenDocuments: noop, log: noop,
    ensureDocumentModel(doc) {
      assert.equal(doc, plain);
      return { findMatches: () => [{ range: {}, matches: ["source"] }], getValue: () => "source", getLineContent: () => "source", getEOL: () => "\n", getValueInRange: () => "source", getOffsetAt: () => 0, pushStackElement: noop, pushEditOperations: () => edited.push(doc.id) };
    },
  });
  context.replaceOpenDocuments();
  assert.deepEqual(edited, [2]);
});
test("global find leaves modal and side-editor keyboard events to their own Monaco", () => {
  class Element { constructor(nested) { this.nested = nested; } closest() { return this.nested; } }
  let opened = 0, prevented = 0;
  const context = harness(["handleGlobalFindKeybinding"], {
    Element, recordingKeybindingCommandId: "", keyboardEventStroke: () => "Ctrl+F", activeCommandBindings: () => ["Ctrl+F"],
    clearPendingKeybindingChord: noop, closeMenus: noop, openCurrentFind: () => opened++,
  });
  for (const nested of ["dialog", "side"]) context.handleGlobalFindKeybinding({ target: new Element(nested), preventDefault: () => prevented++, stopPropagation: noop });
  assert.equal(opened, 0); assert.equal(prevented, 0);
  context.handleGlobalFindKeybinding({ target: new Element(null), preventDefault: () => prevented++, stopPropagation: noop });
  assert.equal(opened, 1); assert.equal(prevented, 1);
});
test("workspace close clears recovery, parallel views and sessions only for its files", async () => {
  const calls = [];
  const workspace = { id: 1, origin: "workspace", model: { dispose: () => calls.push("dispose") } };
  const standalone = { id: 2, origin: "standalone" };
  const state = { workspace: { name: "test" }, documents: [workspace, standalone], activeId: 1, collapsedDirs: new Set() };
  const sessions = new Map([[1, {}], [2, {}]]), stats = new Map([[1, {}], [2, {}]]);
  const context = harness(["closeWorkspace"], {
    state, confirmDocumentCanClose: async () => true, activeDocument: () => workspace, editor: { saveViewState: () => ({}) },
    discardRecovery: doc => calls.push(`discard:${doc.id}`), closeSideEditorFor: doc => calls.push(`side:${doc.id}`),
    writingStatsCache: stats, markdownSessions: sessions, cancelAutoSave: noop, disposeMarkdownEditor: noop, cancelDocumentSizeUpdate: noop,
    $: () => ({ value: "" }), resetSearchResults: noop, isWorkspaceFindView: () => false, attachEditorModel: noop,
    renderAll: noop, renderSettingsMenu: noop, scheduleSessionSave: noop, log: noop,
  });
  await context.closeWorkspace();
  assert.deepEqual(calls, ["discard:1", "side:1", "dispose"]);
  assert.equal(state.documents.length, 1); assert.equal(state.documents[0], standalone);
  assert.equal(sessions.has(1), false); assert.equal(stats.has(1), false); assert.equal(sessions.has(2), true); assert.equal(stats.has(2), true);
});
test("rebinding a side editor applies reading protection and shared display preferences", async () => {
  for (const reading of [true, false]) {
    const doc = { id: 8, readOnly: false };
    let options;
    const context = harness(["openSideEditor", "applyEditorPerformanceProfile"], {
      activeDocument: () => doc, syncMarkdownModelFromEditor: noop, createSideEditor: noop,
      state: { documents: [doc], wordWrap: true, fontSize: 19, minimap: true, renderWhitespace: "all" },
      sideDocumentId: 0, syncActiveBookmarkLines: noop, renderBookmarkDecorations: noop,
      sideEditor: { setModel: noop, editor: { updateOptions: value => { options = value; } } },
      editor: { updateOptions() { assert.fail("side settings changed primary editor"); } },
      document: { documentElement: { style: { setProperty: noop } } },
      resolveEditorFontStack: () => "monospace", editorLineHeight: () => 24,
      ensureDocumentModel: () => ({}), isReadingDocument: () => reading,
    });
    await context.openSideEditor();
    assert.equal(options.readOnly, reading);
    assert.equal(options.wordWrap, "on");
    assert.equal(options.fontSize, 19);
    assert.equal(options.renderWhitespace, "all");
  }
});

test("metadata conversions respect reading mode and schedule recovery when editable", () => {
  for (const reading of [true, false]) {
    const doc = { id: 1, encoding: "UTF-8", lineEnding: "LF", readOnly: false };
    let recovery = 0, edits = 0;
    const context = harness(["convertEncoding", "setLineEnding"], {
      activeDocument: () => doc, commandDocument: () => doc, isReadingDocument: () => reading, closeMenus: noop, renderAll: noop,
      scheduleAutoSave: noop, scheduleSessionSave: noop, log: noop, syncMarkdownModelFromEditor: noop, syncMarkdownEditorFromModel: noop,
      scheduleRecovery: () => recovery++, ensureDocumentModel: () => ({ getValue: () => "one\ntwo", pushStackElement: noop }),
      normalizeLineEndings: () => "one\r\ntwo", replaceModelText: () => edits++,
    });
    context.convertEncoding("GBK"); context.setLineEnding("CRLF");
    assert.equal(recovery, reading ? 0 : 2); assert.equal(edits, reading ? 0 : 1);
    assert.equal(doc.encoding, reading ? "UTF-8" : "GBK"); assert.equal(doc.lineEnding, reading ? "LF" : "CRLF");
    if (!reading) assert.equal(doc.metadataDirty, true);
  }
});

test("replacement reload retains edits made while native disk I/O was pending", async () => {
  const doc = { id: 1, path: "/a", version: 1, dirty: false, diskRevision: "r1", encoding: "UTF-8", lineEnding: "LF" };
  let scheduled = 0;
  const context = harness(["refreshOpenDocumentsAfterReplace"], {
    state: { documents: [doc] }, normalizePathForCompare: value => value, syncMarkdownModelFromEditor: noop,
    documentVersion: doc => doc.version, withBusy: (_, action) => action(),
    invoke: async () => { doc.version = 2; doc.dirty = true; return { text: "disk replacement", diskRevision: "r2" }; },
    applyDocumentDto() { assert.fail("new local edits were overwritten"); }, cancelAutoSave: noop,
    scheduleRecovery: () => scheduled++, log: noop, renderAll: noop,
  });
  await context.refreshOpenDocumentsAfterReplace({ items: [{ path: "/a" }] });
  assert.equal(scheduled, 1); assert.equal(doc.externalRevision, "r2");
});

test("rename persists the new recovery before deleting the old path backup", async () => {
  const doc = { id: 1, path: "new", dirty: true };
  const calls = [], ids = new Map([["old", 42]]);
  const context = harness(["migrateRenamedRecovery"], {
    state: { workbench: { recoveryEnabled: true } }, recoveryKey: doc => doc.path,
    window: { clearTimeout: noop }, recoveryTimers: new Map(), recoveryQueue: Promise.resolve(), recoveryIds: ids,
    persistRecovery: async () => { calls.push("save:new"); ids.set("new", 43); }, invoke: async (_, { request }) => calls.push(`delete:${request.id}`), log: noop,
  });
  context.migrateRenamedRecovery(doc, "old"); await context.recoveryQueue;
  assert.deepEqual(calls, ["save:new", "delete:42"]); assert.equal(ids.has("old"), false); assert.equal(ids.get("new"), 43);
});

test("failed new recovery write retains the only existing renamed-document backup", async () => {
  const ids = new Map([["old", 42]]);
  const context = harness(["migrateRenamedRecovery"], {
    state: { workbench: { recoveryEnabled: true } }, recoveryKey: doc => doc.path,
    window: { clearTimeout: noop }, recoveryTimers: new Map(), recoveryQueue: Promise.resolve(), recoveryIds: ids,
    persistRecovery: async () => { throw new Error("disk full"); }, invoke: async () => assert.fail("old backup deleted"), log: noop,
  });
  context.migrateRenamedRecovery({ id: 1, path: "new", dirty: true }, "old"); await context.recoveryQueue;
  assert.equal(ids.get("old"), 42);
});

test("restoring as a new document still creates a copy when current text matches", async () => {
  const existing = { id: 1, path: "/a", dirty: false, text: "same" };
  const state = { documents: [existing] };
  let activated;
  const context = harness(["restoreSnapshotDocument"], {
    state, normalizePathForCompare: value => value, documentText: doc => doc.text,
    createDocument: dto => ({ ...dto, id: 2 }), scheduleRecovery: noop, activateDocument: id => { activated = id; },
  });
  await context.restoreSnapshotDocument({ path: "/a", title: "a", text: "same", encoding: "UTF-8" }, true);
  assert.equal(state.documents.length, 2); assert.equal(state.documents[1].path, null); assert.equal(activated, 2);
});

test("a missing history source does not abort safe replacement of the remaining preview", async () => {
  const items = [{ fileId: 0, path: "/missing", fileName: "missing" }, { fileId: 1, path: "/good", fileName: "good" }];
  const preview = { previewId: "p1", items };
  const state = { replacePreview: preview, documents: [], workbench: { historyEnabled: true } };
  let applied = false;
  const context = harness(["applyWorkspaceReplace"], {
    state, replaceSelections: new Map([[0, new Set([0])], [1, new Set([0])]]), normalizePathForCompare: value => value,
    askConfirm: async () => true, beginWorkspaceSearch: () => 1, finishWorkspaceSearch: () => true,
    invoke: async (command, args) => {
      if (command === "open_path") { if (args.path === "/missing") throw new Error("missing"); return { text: "before", encoding: "UTF-8", language: "plaintext", lineEnding: "LF" }; }
      if (command === "apply_workspace_replace") { applied = true; return { appliedFiles: 1, appliedMatches: 1, batchId: "b1", failures: [{ path: "/missing", error: "gone" }] }; }
    },
    refreshOpenDocumentsAfterReplace: async () => {}, renderSearchSidebarResults: noop, showWorkbenchError: async () => {}, log: noop,
    failWorkspaceSearch: (_, error) => { throw error; }, lastReplaceBatchId: null, lastReplacePreview: null,
  });
  await context.applyWorkspaceReplace();
  assert.equal(applied, true); assert.equal(context.lastReplaceBatchId, "b1");
  assert.equal(context.lastReplacePreview.items.length, 1); assert.equal(context.lastReplacePreview.items[0].path, "/good");
});
