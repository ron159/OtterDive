import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const noop = () => {};
function harness(names, globals) {
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join("\n");
  const context = vm.createContext({ ...globals });
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}

function moveFixture(onApply = noop, onOpen = noop) {
  const doc = { id: 1, path: "/workspace/a.md", title: "a.md", text: "# before", version: 1, dirty: false,
    encoding: "UTF-8", sourceEncoding: "UTF-8", lineEnding: "LF", diskRevision: "before" };
  const state = { documents: [doc], workspace: null, workbench: { historyEnabled: false } };
  const calls = { reloaded: 0, discarded: 0, recovered: 0, alerts: [] };
  const app = { inert: false };
  const context = harness(["moveWorkspaceEntry"], {
    state, workspaceMoveInProgress: false, $: id => id === "settingsPage" ? { classList: { contains: () => true } } : app, activeDocument: () => doc,
    withBusy: async (_, action) => action(), syncMarkdownModelFromEditor: noop,
    isMarkdownLikeDocument: () => true, pathMatchesTarget: (path, target, directory) => path === target || directory && path.startsWith(target + "/"),
    normalizePathForCompare: value => value, relativeMarkdownPath: (_, path) => path,
    documentVersion: value => value.version, documentText: value => value.text,
    askConfirm: async () => true, saveDocument: async () => { assert.fail("clean document must not be saved"); },
    cancelAutoSave: noop, preserveHistory: noop, rememberMarkdownLocation: noop,
    updateOpenDocumentsForRename: (_, destination) => { doc.path = destination; doc.title = "new.md"; },
    updateCollapsedDirsForRename: noop,
    invoke: async command => {
      if (command === "preview_workspace_move") return { token: "preview", path: "/workspace/a.md", destination: "/workspace/new.md",
        referenceCount: 1, changedDocuments: [{ path: "/workspace/a.md", destinationPath: "/workspace/new.md", referenceCount: 1 }] };
      if (command === "apply_workspace_move") {
        await onApply(doc, state);
        return { destination: "/workspace/new.md", referenceCount: 1,
          changedDocuments: [{ path: "/workspace/a.md", destinationPath: "/workspace/new.md", referenceCount: 1 }], warnings: [] };
      }
      if (command === "open_path") {
        await onOpen(doc, state);
        return { path: "/workspace/new.md", text: "# disk after link maintenance", diskRevision: "after", encoding: "UTF-8", lineEnding: "LF" };
      }
      assert.fail(`unexpected command: ${command}`);
    },
    applyDocumentDto: (value, dto) => { calls.reloaded++; Object.assign(value, dto, { dirty: false }); },
    discardRecovery: () => calls.discarded++, scheduleRecovery: () => calls.recovered++,
    disposeMarkdownEditor: noop, markdownSessions: new Map(), renderAll: noop,
    markdownLocations: {}, documentSessionKey: value => value.path, restoreMarkdownLocation: noop,
    scheduleAutoSave: noop, scheduleSessionSave: noop, log: noop, showAlert: async options => calls.alerts.push(options),
  });
  return { context, doc, calls, app, run: () => context.moveWorkspaceEntry("/workspace", "/workspace/a.md", "/workspace/new.md", false) };
}

test("a model edit during native move survives link-refresh and keeps recovery", async () => {
  const fixture = moveFixture(doc => { doc.text = "# changed while native move was pending"; doc.version++; doc.dirty = true; });
  assert.equal(await fixture.run(), true);
  assert.equal(fixture.doc.path, "/workspace/new.md");
  assert.equal(fixture.doc.text, "# changed while native move was pending");
  assert.equal(fixture.doc.dirty, true);
  assert.equal(fixture.calls.reloaded, 0);
  assert.equal(fixture.calls.discarded, 0);
  assert.equal(fixture.calls.recovered, 1);
  assert.equal(fixture.calls.alerts.length, 1);
  assert.equal(fixture.app.inert, false);
  assert.equal(fixture.context.workspaceMoveInProgress, false);
});

test("metadata changes during native move remain dirty and recoverable", async () => {
  const fixture = moveFixture(doc => { doc.encoding = "GBK"; doc.lineEnding = "CRLF"; doc.dirty = true; doc.metadataDirty = true; });
  assert.equal(await fixture.run(), true);
  assert.equal(fixture.doc.encoding, "GBK");
  assert.equal(fixture.doc.lineEnding, "CRLF");
  assert.equal(fixture.calls.reloaded, 0);
  assert.equal(fixture.calls.discarded, 0);
  assert.equal(fixture.calls.recovered, 1);
});

test("an asynchronous edit during the post-move read is not overwritten", async () => {
  const fixture = moveFixture(noop, doc => { doc.text = "# formatter completed during refresh"; doc.version++; doc.dirty = true; });
  assert.equal(await fixture.run(), true);
  assert.equal(fixture.doc.text, "# formatter completed during refresh");
  assert.equal(fixture.doc.dirty, true);
  assert.equal(fixture.calls.reloaded, 0);
  assert.equal(fixture.calls.discarded, 0);
  assert.equal(fixture.calls.recovered, 1);
  assert.equal(fixture.calls.alerts.length, 1);
});

test("an unchanged document reloads the maintained links after a successful move", async () => {
  const fixture = moveFixture();
  assert.equal(await fixture.run(), true);
  assert.equal(fixture.doc.text, "# disk after link maintenance");
  assert.equal(fixture.doc.dirty, false);
  assert.equal(fixture.calls.reloaded, 1);
  assert.equal(fixture.calls.discarded, 1);
  assert.equal(fixture.calls.recovered, 0);
  assert.equal(fixture.calls.alerts.length, 0);
  assert.equal(fixture.app.inert, false);
});

test("move guard blocks application commands and both automatic save triggers", async () => {
  const doc = { id: 1, path: "/workspace/a.md", dirty: true, readOnly: false };
  const context = harness(["commandIsAvailable", "executeAppCommand", "scheduleAutoSave", "saveOnFocusChange"], {
    state: { documents: [doc], workbench: { autoSaveMode: "afterDelay" }, restoring: false },
    workspaceMoveInProgress: true, restoringRecovery: false,
    closeMenus: noop, showWorkbenchError: async () => {}, log: noop, cancelAutoSave: noop,
    commandDocument: () => doc, isReadingDocument: () => false,
    autoSaveTimers: new Map(), window: { setTimeout: () => assert.fail("autosave was scheduled during move") },
    saveDocument: () => assert.fail("autosave wrote during move"),
  });
  assert.equal(context.commandIsAvailable({ id: "file.save", allowInInput: true }), false);
  await context.executeAppCommand({ id: "markdown.insertToc", run: () => assert.fail("command ran during move") });
  context.scheduleAutoSave(doc);
  context.state.workbench.autoSaveMode = "onFocusChange";
  context.saveOnFocusChange(doc);
});
