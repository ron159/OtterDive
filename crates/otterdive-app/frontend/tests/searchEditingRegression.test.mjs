import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { Range } from "monaco-editor/esm/vs/editor/common/core/range.js";
import { SearchParams, TextModelSearch } from "monaco-editor/esm/vs/editor/common/model/textModelSearch.js";

const replacementSource = fs.readFileSync(new URL("../src/searchReplacement.ts", import.meta.url), "utf8");
const replacementJavascript = ts.transpileModule(replacementSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { regexReplacementAt } = await import(`data:text/javascript;base64,${Buffer.from(replacementJavascript).toString("base64")}`);

// Exercise production replacement commands and Monaco's matcher with an in-memory model and DOM.
const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "replaceCurrentFile", "replaceAllCurrentFile", "replaceOpenDocuments",
  "currentReplaceContext", "currentReplaceMatchIndex", "modelMatches", "matchAllowed",
  "activeSearchSelectionRange", "rangeContainsRange", "comparePosition", "isWordChar",
  "rangeFromMatch", "replacementForMatch", "getSearchMode", "setSearchMode",
  "editorSearchQuery", "translateExtended", "initialSearchResultIndex",
  "currentSearchPatternError", "syncSearchControlsToCurrent", "syncCurrentFindControls",
  "captureCurrentSearchSelection", "selectionSignature", "currentSearchSignature",
  "findNextResult", "findPreviousResult", "navigateSearchResult", "openSearchResult",
  "flattenSearchResults", "flattenSearchReport", "searchDirection",
]);
const handlers = ts.transpileModule(
  ast.statements.filter(node => ts.isFunctionDeclaration(node) && functionNames.has(node.name?.text))
    .map(node => node.getText(ast)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const noop = () => {};

function textModel(initialText) {
  let text = initialText;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const withEol = (value, preference = 0) => value.replace(/\r\n|\r|\n/g, preference === 1 ? "\n" : preference === 2 ? "\r\n" : eol);
  function lineStarts() {
    return [0, ...Array.from(text.matchAll(/\r\n|\r|\n/g), match => match.index + match[0].length)];
  }
  function getPositionAt(offset) {
    const starts = lineStarts();
    const line = starts.findLastIndex(start => start <= offset);
    return { lineNumber: line + 1, column: offset - starts[line] + 1 };
  }
  function getOffsetAt({ lineNumber, column }) {
    const start = lineStarts()[lineNumber - 1];
    const lineLength = text.slice(start).split(/\r\n|\r|\n/, 1)[0].length;
    return start + Math.min(column - 1, lineLength);
  }
  function offsets(range) {
    return [
      getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
      getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }),
    ];
  }
  const model = {
    getValue: preference => withEol(text, preference),
    getEOL: () => eol,
    getPositionAt,
    getOffsetAt,
    getLineContent: lineNumber => text.split(/\r\n|\r|\n/)[lineNumber - 1],
    getValueInRange(range, preference) { return withEol(text.slice(...offsets(range)), preference); },
    findMatches(query, _scope, isRegex, matchCase, wordSeparators, captureMatches, limit = 999) {
      const end = getPositionAt(text.length);
      // Use Monaco's actual matcher, including CRLF offset mapping and line-based matching.
      return TextModelSearch.findMatches(model, new SearchParams(query, isRegex, matchCase, wordSeparators),
        new Range(1, 1, end.lineNumber, end.column), captureMatches, limit);
    },
    pushEditOperations(_selections, edits) {
      const replacements = edits.map(edit => ({ offsets: offsets(edit.range), text: edit.text }))
        .sort((a, b) => b.offsets[0] - a.offsets[0]);
      for (const edit of replacements) {
        const [start, end] = edit.offsets;
        text = text.slice(0, start) + withEol(edit.text) + text.slice(end);
      }
    },
    pushStackElement: noop,
  };
  return model;
}

function setup({ text, query, replacement, mode = "regex", matchCase = true, wholeWord = false, documents = [text] }) {
  const controls = new Map();
  const input = id => {
    if (!controls.has(id)) controls.set(id, { value: "", checked: false, querySelectorAll: () => [] });
    return controls.get(id);
  };
  input("findInput").value = query;
  input("replaceInput").value = replacement;
  input("matchCaseInput").checked = matchCase;
  input("wholeWordInput").checked = wholeWord;
  const radios = ["literal", "extended", "regex"].map(value => ({
    value,
    get checked() { return mode === value; },
    set checked(checked) { if (checked) mode = value; },
  }));
  const docs = documents.map((value, index) => ({
    id: index + 1, title: `sample-${index + 1}.txt`, readOnly: false, model: textModel(value),
  }));
  const context = vm.createContext({
    monaco: { Range, editor: { EndOfLinePreference: { TextDefined: 0, LF: 1, CRLF: 2 } } },
    regexReplacementAt,
    currentSearchSelectionDocumentId: 0,
    currentSearchSelection: null,
    searchResultNavigationDepth: 0,
    state: { documents: docs, activeResultIndex: -1 },
    $: input,
    document: {
      querySelector(selector) {
        if (selector === 'input[name="searchMode"]:checked') return radios.find(radio => radio.checked);
        const value = selector.match(/\[value="(.*?)"\]/)?.[1];
        return radios.find(radio => radio.value === value) ?? null;
      },
    },
    activeDocument: () => docs[0],
    ensureDocumentModel: doc => doc.model,
    isReadingDocument: () => false,
    isMarkdownWysiwygActive: () => false,
    editor: { getSelection: () => null, getPosition: () => ({ lineNumber: 1, column: 1 }) },
    isSideEditorActive: () => false,
    cancelScheduledCurrentFind: noop,
    rerunSearchForNavigation() { assert.fail("unchanged selection search should retain its result list"); },
    searchAllOpenFilesEnabled: () => input("allOpenFilesInput").checked,
    markdownEditor: null,
    syncMarkdownModelFromEditor: noop,
    commitSearchHistory: noop,
    commitReplaceHistory: noop,
    setCurrentFindError: noop,
    findCurrent: noop,
    findSelectedDocuments: noop,
    findOpenDocuments: noop,
    renderCurrentFindMode: noop,
    renderCurrentFindCount: noop,
    renderSearchDecorations: noop,
    scrollActiveResultIntoView: noop,
    scheduleSessionSave: noop,
    log: noop,
  });
  vm.runInContext(handlers, context);
  return { context, input, docs, value: () => docs[0].model.getValue() };
}

const replacements = [
  {
    name: "lookbehind retains the preceding text needed to match",
    text: "foobar", query: "(?<=foo)bar", replacement: "X", expected: "fooX",
  },
  {
    name: "lookahead retains the following text needed to match",
    text: "foobar", query: "foo(?=bar)", replacement: "X", expected: "Xbar",
  },
  {
    name: "line anchors work inside a multiline match",
    text: "keep\nfoo\nbar\nkeep", query: "^foo$\\n^bar$", replacement: "X", expected: "keep\nX\nkeep",
  },
  {
    name: "capture groups, whole matches and literal dollars expand once",
    text: "foobar", query: "(?<word>f)(oo)(b)(ar)",
    replacement: "$<word>-$2-$3-$4-$&-$$", expected: "f-oo-b-ar-foobar-$",
  },
  {
    name: "capture groups inside lookbehind remain available to replacement",
    text: "foobar", query: "(?<=(foo))(bar)", replacement: "$1:$2", expected: "foofoo:bar",
  },
  {
    name: "case-insensitive context matches replace every occurrence",
    text: "FOObar fooBAR", query: "(?<=foo)bar", replacement: "X", matchCase: false, expected: "FOOX fooX",
  },
  {
    name: "zero-width matches insert without deleting the following character",
    text: "foobar", query: "(?=bar)", replacement: "X", expected: "fooXbar",
  },
  {
    name: "literal replacements preserve dollar syntax verbatim",
    text: "foobar", query: "bar", replacement: "$& $1 $<word> $$", mode: "literal",
    expected: "foo$& $1 $<word> $$",
  },
  {
    name: "CRLF multiline captures replace the same range found by Monaco",
    text: "keep\r\nfoo\r\nbar\r\nkeep", query: "(foo)\\n(bar)", replacement: "$2:$1",
    expected: "keep\r\nbar:foo\r\nkeep",
  },
  {
    name: "dollar tokens distinguish missing groups, numbered suffixes and escaped tokens",
    text: "a", query: "(?<word>a)(b)?", replacement: "$0|$00|$01|$10|$12|$99|$100|$$1|$$&|$<missing>|$2|$<>",
    expected: "$0|$00|a|a0|a2|$99|a00|$1|$&|||",
  },
  {
    name: "named replacements stay literal when the expression has no named groups",
    text: "a", query: "(a)", replacement: "$<word>-$<>", expected: "$<word>-$<>",
  },
  {
    name: "lookahead captures use Monaco's line scope for single-line expressions",
    text: "foo\nbar", query: "(foo)(?=([\\s\\S]*))", replacement: "$1<$2>", expected: "foo<>\nbar",
  },
  {
    name: "whole-word matching checks the final line of a multiline match",
    text: "foo\nbarX", query: "foo\\nbar", replacement: "X", wholeWord: true, expected: "foo\nbarX",
  },
];

for (const command of ["replaceAllCurrentFile", "replaceOpenDocuments"]) {
  for (const scenario of replacements) {
    test(`${command}: ${scenario.name}`, () => {
      const h = setup(scenario);
      h.context[command]();
      assert.equal(h.value(), scenario.expected);
    });
  }
}

test("single replacement uses the same lookbehind context and leaves later matches intact", () => {
  const h = setup({ text: "foobar foobar", query: "(?<=foo)bar", replacement: "X" });
  h.context.replaceCurrentFile();
  assert.equal(h.value(), "fooX foobar");
});

test("single replacement preserves CRLF context and numbered captures", () => {
  const h = setup({ text: "keep\r\nfoo\r\nbar\r\nkeep", query: "(foo)\\n(bar)", replacement: "$2:$1" });
  h.context.replaceCurrentFile();
  assert.equal(h.value(), "keep\r\nbar:foo\r\nkeep");
});

for (const command of ["replaceCurrentFile", "replaceAllCurrentFile", "replaceOpenDocuments"]) {
  for (const query of ["(", "(?:)"]) {
    test(`${command}: rejected regular expressions leave the document unchanged (${query})`, () => {
      const h = setup({ text: "foobar", query, replacement: "X" });
      let error;
      h.context.setCurrentFindError = message => { error = message; };
      h.context[command]();
      assert.equal(h.value(), "foobar");
      assert.ok(error);
    });
  }
}

test("replacing open documents resolves regular-expression context separately for each file", () => {
  const h = setup({
    documents: ["foobar", "bar fooBAR", "unrelated"], query: "(?<=foo)bar", replacement: "X", matchCase: false,
  });
  h.context.replaceOpenDocuments();
  assert.deepEqual(h.docs.map(doc => doc.model.getValue()), ["fooX", "bar fooX", "unrelated"]);
});

test("replace-all in open documents handles matches beyond Monaco's default search limit", () => {
  const h = setup({ text: "a ".repeat(1100), query: "a", replacement: "b", mode: "literal" });
  h.context.replaceOpenDocuments();
  assert.equal(h.value(), "b ".repeat(1100));
});

test("synchronizing the current find bar preserves extended mode and escaped replacement text", () => {
  const h = setup({ text: "one\ntwo", query: "one\\ntwo", replacement: "$&\\tX", mode: "extended" });
  h.context.syncSearchControlsToCurrent();
  h.context.syncCurrentFindControls();
  assert.equal(h.context.getSearchMode(), "extended");
  h.context.replaceAllCurrentFile();
  assert.equal(h.value(), "$&\tX");
});

test("the current find regex toggle can enable and disable regular expressions", () => {
  const h = setup({ text: "a.b", query: "a.b", replacement: "X", mode: "literal" });
  h.context.syncSearchControlsToCurrent();
  h.input("currentRegexInput").checked = true;
  h.context.syncCurrentFindControls();
  assert.equal(h.context.getSearchMode(), "regex");
  h.input("currentRegexInput").checked = false;
  h.context.syncCurrentFindControls();
  assert.equal(h.context.getSearchMode(), "literal");
});

test("zero-width navigation advances and wraps within the original captured selection", async () => {
  const h = setup({ text: "foobar foobar outsidebar", query: "(?=bar)", replacement: "X" });
  let selection = new Range(1, 1, 1, 14);
  let captured = [];
  const positions = [];
  h.context.editor.getSelection = () => selection;
  h.context.editor.createDecorationsCollection = () => ({
    set: values => { captured = values; },
    getRange: index => captured[index]?.range ?? null,
  });
  h.input("searchSelectionInput").checked = true;
  h.input("wrapSearchInput").checked = true;
  h.context.captureCurrentSearchSelection();
  const matches = h.context.modelMatches(h.docs[0]);
  assert.equal(matches.length, 2);
  Object.assign(h.context.state, {
    activeResultIndex: 0,
    searchScope: "current",
    searchQuery: "(?=bar)",
    results: { total: matches.length, hits: [{ path: h.docs[0].title, matches }] },
  });
  h.context.state.searchSignature = h.context.currentSearchSignature("current");
  h.context.openResult = async (_path, line, column) => {
    positions.push(column);
    selection = new Range(line, column, line, column);
    return h.docs[0];
  };
  await h.context.findNextResult();
  await h.context.findPreviousResult();
  await h.context.findNextResult();
  await h.context.findNextResult();
  assert.deepEqual(positions, [11, 4, 11, 4]);
  assert.equal(h.context.modelMatches(h.docs[0]).length, 2);
  assert.equal(h.context.state.activeResultIndex, 0);
});
