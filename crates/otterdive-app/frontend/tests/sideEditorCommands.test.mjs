import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "commandDocument", "commandEditor", "isSideEditorActive", "saveActive", "saveAsActive",
  "runEditorAction", "undoEditor", "redoEditor", "selectAllEditor", "openCurrentFind", "syncMarkdownEditorFromModel",
]);
const js = ts.transpileModule(ast.statements
  .filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(ast)).join("\n"),
{ compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup({ side = true, readOnly = false, reading = false, wysiwyg = false } = {}) {
  const primary = { id: 1, text: "primary", readOnly: false };
  const secondary = { id: 2, text: "side", readOnly, reading };
  const saved = [];
  function view(doc) {
    let original = doc.text;
    return {
      getModel: () => doc,
      focus() {},
      trigger(_, action) {
        if (action === "editor.action.copyLinesDownAction") { original = doc.text; doc.text += "\n" + doc.text; }
        if (action === "undo") doc.text = original;
        if (action === "editor.action.selectAll") doc.selection = doc.text;
        if (action === "actions.find") doc.findOpen = true;
        if (action === "editor.action.startFindReplaceAction") doc.replaceOpen = true;
      },
    };
  }
  const context = vm.createContext({
    state: { activeId: 1, documents: [primary, secondary] },
    editor: view(primary), sideEditor: { editor: view(secondary) }, sideDocumentId: 2,
    sideEditorFocused: side, activeDocument: () => primary,
    isReadingDocument: (doc = primary) => Boolean(doc.reading),
    isMarkdownWysiwygActive: () => wysiwyg,
    markdownEditorDocumentId: 1, editorBusyDepth: 0, isMarkdownLikeDocument: () => true, documentText: doc => doc.text,
    markdownEditor: { undo() { primary.text = "wrong undo"; }, selectAll() { primary.selection = primary.text; }, setMarkdown(text) { primary.text = text; }, setReadOnly() {} },
    saveDocument: async (doc, saveAs) => { saved.push({ id: doc.id, saveAs }); return true; },
    showWorkbenchError: async error => { throw error; },
    setFindView() { primary.findOpen = true; }, toggleFindOpen() {}, log() {},
  });
  vm.runInContext(js, context);
  return { context, primary, secondary, saved };
}

test("duplicate and undo use the side document while the primary tab stays active", () => {
  const h = setup();
  h.context.runEditorAction("editor.action.copyLinesDownAction");
  assert.equal(h.secondary.text, "side\nside");
  assert.equal(h.primary.text, "primary");
  h.context.undoEditor();
  assert.equal(h.secondary.text, "side");
  assert.equal(h.context.state.activeId, 1);
});

test("toolbar save and Save As retain the last focused side document", async () => {
  const h = setup();
  await h.context.saveActive();
  await h.context.saveAsActive();
  assert.deepEqual(h.saved, [{ id: 2, saveAs: false }, { id: 2, saveAs: true }]);
});

test("side selection and find do not operate on primary Markdown", () => {
  const h = setup({ wysiwyg: true });
  h.context.selectAllEditor();
  h.context.openCurrentFind("replace");
  assert.equal(h.secondary.selection, "side");
  assert.equal(h.secondary.replaceOpen, true);
  assert.equal(h.primary.selection, undefined);
  assert.equal(h.primary.findOpen, undefined);
});

test("read-only and reading side documents reject edits but allow selection", () => {
  for (const options of [{ readOnly: true }, { reading: true }]) {
    const h = setup(options);
    h.context.runEditorAction("editor.action.copyLinesDownAction");
    h.context.selectAllEditor();
    assert.equal(h.secondary.text, "side");
    assert.equal(h.primary.text, "primary");
    assert.equal(h.secondary.selection, "side");
  }
});

test("returning to the primary editor routes edits and saves back to its document", async () => {
  const h = setup({ side: false });
  h.context.runEditorAction("editor.action.copyLinesDownAction");
  await h.context.saveActive();
  assert.equal(h.primary.text, "primary\nprimary");
  assert.equal(h.secondary.text, "side");
  assert.deepEqual(h.saved, [{ id: 1, saveAs: false }]);
});

test("converting a background side document does not replace the primary rich editor", () => {
  const h = setup({ wysiwyg: true });
  h.context.syncMarkdownEditorFromModel(h.secondary);
  assert.equal(h.primary.text, "primary");
  assert.equal(h.context.markdownEditorDocumentId, 1);
});
