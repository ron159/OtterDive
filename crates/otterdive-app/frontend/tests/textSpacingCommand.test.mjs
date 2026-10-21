import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "esbuild";
import { Range } from "monaco-editor/editor/common/core/range.js";
import { Selection } from "monaco-editor/editor/common/core/selection.js";

const output = await build({
  stdin: {
    contents: 'export { textSpacingEdits } from "./textSpacing"; export { sourceSelectionToMarkdownCursor, markdownCursorToSourceSelection } from "./markdownNavigation";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { textSpacingEdits, sourceSelectionToMarkdownCursor, markdownCursorToSourceSelection } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["canOptimizeTextSpacing", "optimizeActiveTextSpacing"]);
const javascript = ts.transpileModule(
  ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    .map(node => node.getText(ast)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const noop = () => {};

function setup({ text = "中文English123文字", language = "plaintext", readOnly = false, reading = false, paged = false, history = async () => {} } = {}) {
  let value = text;
  let version = 1;
  let selection = new Selection(1, 1, 1, 1);
  const calls = { history: [], batches: [], undoStops: 0, recovery: 0 };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const model = {
    getValue: () => value,
    getEOL: () => eol,
    getLanguageId: () => language,
    getVersionId: () => version,
    getAlternativeVersionId: () => version,
    isDisposed: () => false,
    getOffsetAt({ lineNumber, column }) {
      const lines = value.split(eol);
      return lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + eol.length, 0) + column - 1;
    },
    getPositionAt(offset) {
      const lines = value.slice(0, offset).split(eol);
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
    },
    pushStackElement() { calls.undoStops++; },
    pushEditOperations(_selections, operations, cursorStateComputer) {
      applyEdits(operations);
      return cursorStateComputer?.([]) ?? null;
    },
  };
  function applyEdits(operations) {
    calls.batches.push(operations.map(operation => ({ range: operation.range, text: operation.text })));
    const edits = operations.map(({ range, text }) => ({
      start: model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
      end: model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }), text,
    })).sort((a, b) => b.start - a.start);
    for (const edit of edits) value = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
    version++;
  }
  const doc = { id: 1, title: language === "markdown" ? "notes.md" : "notes.txt", language, model, readOnly, reading, paged };
  let active = doc;
  const editor = {
    getModel: () => model,
    getSelection: () => selection,
    getPosition: () => selection.getPosition(),
    setSelection: next => { selection = Selection.liftSelection(next); },
    setPosition: next => { selection = new Selection(next.lineNumber, next.column, next.lineNumber, next.column); },
    pushUndoStop() { calls.undoStops++; },
    executeEdits(_source, operations, cursorState) {
      applyEdits(operations);
      if (Array.isArray(cursorState) && cursorState[0]) selection = Selection.liftSelection(cursorState[0]);
      return true;
    },
    focus: noop,
  };
  const context = vm.createContext({
    monaco: { Range, Selection }, textSpacingEdits,
    commandDocument: () => active, activeDocument: () => active,
    commandEditor: () => editor, editor,
    ensureDocumentModel: document => document.model,
    documentText: () => value, documentVersion: () => version,
    isMarkdownLikeDocument: document => document.language === "markdown",
    isReadingDocument: document => (document ?? active).reading,
    isMarkdownWysiwygActive: () => false, isSideEditorActive: () => false,
    syncMarkdownModelFromEditor: noop, syncMarkdownEditorFromModel: noop,
    sourceSelectionToMarkdownCursor, markdownCursorToSourceSelection,
    preserveHistory: async (_doc, before) => { calls.history.push(before); await history(); },
    scheduleRecovery: () => { calls.recovery++; },
    scheduleSessionSave: noop, renderChrome: noop, renderAll: noop,
    closeMenus: noop, log: noop, showAlert: async () => {},
    markdownEditor: null, editorBusyDepth: 0, busyDepth: 0, workspaceMoveInProgress: false,
    state: { documents: [doc], activeId: doc.id },
  });
  vm.runInContext(javascript, context);
  return {
    context, doc, model, calls,
    run: () => context.optimizeActiveTextSpacing(),
    value: () => value,
    selection: () => selection,
    selectOffsets(anchor, focus = anchor) {
      const from = model.getPositionAt(anchor), to = model.getPositionAt(focus);
      selection = new Selection(from.lineNumber, from.column, to.lineNumber, to.column);
    },
    userEdit(next) { value = next; version++; },
    switchDocument() { active = { ...doc, id: 2 }; context.state.documents.push(active); context.state.activeId = 2; },
  };
}

test("source-mode full-document optimization preserves CRLF and the caret with one undoable edit batch", async () => {
  const original = "中文English123文字\r\n下一行ABC";
  const h = setup({ text: original });
  h.selectOffsets(5);
  assert.equal(h.context.canOptimizeTextSpacing(), true);
  await h.run();
  assert.equal(h.value(), "中文 English123 文字\r\n下一行 ABC");
  assert.deepEqual(h.calls.history, [original]);
  assert.equal(h.calls.batches.length, 1);
  assert.equal(h.calls.batches[0].length, 3);
  assert.equal(h.calls.undoStops, 2);
  assert.equal(h.selection().positionLineNumber, 1);
  assert.equal(h.selection().positionColumn, 7);
});

test("reverse selection changes only its interior and preserves its anchor and focus direction", async () => {
  const h = setup({ text: "外部English 中文ABC文字 尾部English" });
  h.selectOffsets(17, 10);
  await h.run();
  assert.equal(h.value(), "外部English 中文 ABC 文字 尾部English");
  assert.equal(h.selection().selectionStartColumn, 20);
  assert.equal(h.selection().positionColumn, 11);
  assert.equal(h.calls.batches[0].length, 2);
});

test("a Markdown selection wholly inside code retains full-document protection context", async () => {
  const original = "正文English\n\n```js\n中文English123\n```\n\n末尾ABC";
  const h = setup({ text: original, language: "markdown" });
  const start = original.indexOf("中文English");
  h.selectOffsets(start, start + "中文English123".length);
  await h.run();
  assert.equal(h.value(), original);
  assert.equal(h.calls.batches.length, 0);
  assert.equal(h.calls.history.length, 0);
});

test("availability rejects read-only, reading, paged, busy, moving and programming-language documents", async () => {
  for (const options of [
    { readOnly: true }, { reading: true }, { paged: true }, { language: "javascript" },
    { busy: true }, { moving: true },
  ]) {
    const h = setup(options);
    h.context.editorBusyDepth = options.busy ? 1 : 0;
    h.context.workspaceMoveInProgress = Boolean(options.moving);
    assert.equal(h.context.canOptimizeTextSpacing(), false, JSON.stringify(options));
    await h.run();
    assert.equal(h.value(), "中文English123文字");
    assert.equal(h.calls.batches.length, 0);
  }
});

test("history completion cannot overwrite a user edit made while awaiting the snapshot", async () => {
  let release;
  const h = setup({ history: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.run();
  await Promise.resolve();
  assert.equal(typeof release, "function");
  h.userEdit("中文English123文字 新编辑");
  release();
  await pending;
  assert.equal(h.value(), "中文English123文字 新编辑");
  assert.equal(h.calls.batches.length, 0);
});

test("history completion cannot edit the old document after the user changes the command target", async () => {
  let release;
  const h = setup({ history: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.run();
  await Promise.resolve();
  assert.equal(typeof release, "function");
  h.switchDocument();
  release();
  await pending;
  assert.equal(h.value(), "中文English123文字");
  assert.equal(h.calls.batches.length, 0);
});
