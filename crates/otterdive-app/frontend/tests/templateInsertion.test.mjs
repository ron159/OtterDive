import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const noop = () => {};

function setup(eol, choose) {
  let value = `before selected after${eol}last`;
  let version = 1;
  let cursor;
  let edits = 0;
  const model = {
    getEOL: () => eol,
    getOffsetAt({ lineNumber, column }) {
      const lines = value.split(eol);
      return lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + eol.length, 0) + column - 1;
    },
    getPositionAt(offset) {
      const lines = value.slice(0, offset).split(eol);
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
    },
    pushStackElement: noop,
    pushEditOperations(_, operations) {
      for (const { range, text } of operations) {
        const start = this.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
        const end = this.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
        value = value.slice(0, start) + text.replace(/\r\n?|\n/g, eol) + value.slice(end);
        version++;
        edits++;
      }
    },
  };
  const doc = { id: 1, title: "notes.md", readOnly: false, model };
  let active = doc;
  const editor = {
    getSelection: () => ({ selectionStartLineNumber: 1, selectionStartColumn: 8, positionLineNumber: 1, positionColumn: 16 }),
    setPosition: position => { cursor = position; },
  };
  const context = vm.createContext({
    activeDocument: () => active, commandDocument: () => active, commandEditor: () => editor, editor,
    isMarkdownLikeDocument: () => true, isReadingDocument: () => false, isMarkdownWysiwygActive: () => false, isSideEditorActive: () => false,
    syncMarkdownModelFromEditor: noop, ensureDocumentModel: () => model, documentVersion: () => version, closeMenus: noop,
    syncMarkdownEditorFromModel: noop, scheduleRecovery: noop, documentText: () => value,
    normalizeLineEndings: (text, lineEnding) => text.replace(/\r\n?|\n/g, lineEnding === "CRLF" || lineEnding === "\r\n" ? "\r\n" : "\n"),
    sourceSelectionToMarkdownCursor: selection => ({
      anchor: { line: selection.selectionStartLineNumber - 1, ch: selection.selectionStartColumn - 1 },
      focus: { line: selection.positionLineNumber - 1, ch: selection.positionColumn - 1 },
    }),
    showDocumentTemplates: async options => choose(options, { changeVersion: () => version++, changeDocument: () => { active = { ...doc, id: 2 }; } }),
    monaco: { Range: class {
      constructor(startLineNumber, startColumn, endLineNumber, endColumn) { Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn }); }
    } },
  });
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "insertDocumentTemplate")
    .map(node => node.getText(ast)).join("\n")
    .replace('await import("./documentTemplates")', "await Promise.resolve({ showDocumentTemplates: globalThis.showDocumentTemplates })");
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { run: () => context.insertDocumentTemplate(), value: () => value, cursor: () => cursor, edits: () => edits };
}

for (const [label, eol] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`template replaces only the original selection and places the caret after all inserted ${label} lines`, async () => {
    const harness = setup(eol, async options => options.onUse("A\nB\n"));
    await harness.run();
    assert.equal(harness.value(), `before A${eol}B${eol} after${eol}last`);
    assert.equal(harness.cursor().lineNumber, 3);
    assert.equal(harness.cursor().column, 1);
    assert.equal(harness.edits(), 1);
  });
}

test("document edits while choosing a template reject the stale insertion", async () => {
  const harness = setup("\n", async (options, actions) => {
    actions.changeVersion();
    assert.throws(() => options.onUse("replacement"), /变化/);
  });
  await harness.run();
  assert.equal(harness.edits(), 0);
  assert.equal(harness.value(), "before selected after\nlast");
});

test("changing the active document while choosing a template does not edit either document", async () => {
  const harness = setup("\n", async (options, actions) => {
    actions.changeDocument();
    assert.throws(() => options.onUse("replacement"), /变化/);
  });
  await harness.run();
  assert.equal(harness.edits(), 0);
});
