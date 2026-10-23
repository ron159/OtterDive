import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "createDocument", "rememberClosedDocument", "reopenClosedDocument", "documentText",
  "checkExternalFiles", "saveDocument",
]);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(ast)).join("\n");
const js = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const noop = () => {};

function harness(overrides = {}) {
  const calls = { reads: [], writes: [], conflicts: 0 };
  const context = {
    nextId: 1, closedDocuments: [], state: { documents: [], activeId: 0, searchRevision: 0 },
    appReady: true, checkingExternalFiles: false, closingEditorsLocked: false, busyDepth: 0,
    confirmResolver: null, unsavedResolver: null, textInputResolver: null,
    document: { visibilityState: "visible" },
    languageWithOverride: (language, override) => override ?? language,
    createDraftId: () => "draft", documentVersion: () => 1,
    ensureDocumentModel: doc => {
      doc.model ??= { getValue: () => doc.text };
      return doc.model;
    },
    activateDocument: id => { context.state.activeId = id; },
    confirmDiskOverwrite: async () => { calls.conflicts++; return false; },
    showExternalConflict: async () => { calls.conflicts++; return false; },
    invoke: async (command, args) => {
      if (command === "file_revisions") return args.paths.map(path => ({ path, revision: "external" }));
      if (command === "reopen_path_with_encoding") {
        calls.reads.push(args.request);
        return { text: "external content", diskRevision: "external", encoding: args.request.encoding };
      }
      if (command === "save_document") { calls.writes.push(args.request); return {}; }
      throw new Error(command);
    },
    applyDocumentDto: (doc, dto) => Object.assign(doc, dto, { dirty: false }),
    editor: { saveViewState: () => ({}), restoreViewState: noop },
    analysePanel: null,
    openPath: async () => { throw new Error("file unavailable"); },
    ...Object.fromEntries([
      "syncMarkdownModelFromEditor", "cancelAutoSave", "preserveHistory", "discardRecovery", "scheduleAutoSave",
      "attachEditorModel", "renderAll", "scheduleSessionSave", "renderChrome", "log", "reportPersistenceError",
    ].map(name => [name, noop])),
  };
  vm.createContext(context);
  vm.runInContext(js, context);
  const original = {
    id: 10, path: "/file.txt", title: "file.txt", text: "original content", diskRevision: "original",
    encoding: "GBK", sourceEncoding: "GBK", encodingStatus: "重新解释", lineEnding: "LF", language: "plaintext",
    dirty: false, metadataDirty: false, readOnly: false, origin: "standalone", savedText: "",
    ...overrides,
  };
  context.rememberClosedDocument(original);
  return { context, original, calls, reopen: async () => {
    await context.reopenClosedDocument();
    return context.state.documents.at(-1);
  } };
}

test("reopened clean files retain their disk baseline and refresh using the chosen source encoding", async () => {
  const h = harness();
  const reopened = await h.reopen();
  assert.equal(reopened.diskRevision, "original");
  assert.equal(reopened.sourceEncoding, "GBK");
  assert.equal(reopened.encodingStatus, "重新解释");
  await h.context.checkExternalFiles();
  assert.equal(reopened.text, "external content");
  assert.equal(h.calls.reads.length, 1);
  assert.equal(h.calls.reads[0].encoding, "GBK");
});

test("reopening discarded edits retains pending encoding conversion and prevents automatic conflict overwrite", async () => {
  const h = harness({ dirty: true, metadataDirty: true, encoding: "UTF-8", encodingStatus: "转换待保存" });
  const reopened = await h.reopen();
  assert.equal(reopened.text, "original content");
  assert.equal(reopened.dirty, true);
  assert.equal(reopened.metadataDirty, true);
  assert.equal(reopened.encoding, "UTF-8");
  assert.equal(reopened.sourceEncoding, "GBK");
  assert.equal(reopened.encodingStatus, "转换待保存");
  assert.equal(await h.context.saveDocument(reopened, false, true), false);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(await h.context.saveDocument(reopened, false), false);
  assert.equal(h.calls.conflicts, 1);
  assert.equal(h.calls.writes.length, 0);
});

test("reopening a retained external conflict preserves the prior keep-current decision", async () => {
  const h = harness({ dirty: true, externalRevision: "external" });
  const reopened = await h.reopen();
  assert.equal(reopened.externalRevision, "external");
  await h.context.checkExternalFiles();
  assert.equal(h.calls.conflicts, 0);
  assert.equal(h.calls.reads.length, 0);
  assert.equal(reopened.text, "original content");
});

test("failed reopening of a paged file keeps the closed tab available for retry", async () => {
  const h = harness({ paged: true });
  await assert.rejects(h.reopen(), /file unavailable/);
  assert.equal(h.context.closedDocuments.length, 1);
  assert.equal(h.context.closedDocuments[0].path, "/file.txt");
  let opened = false;
  h.context.openPath = async () => { opened = true; };
  await h.reopen();
  assert.equal(opened, true);
  assert.equal(h.context.closedDocuments.length, 0);
});
