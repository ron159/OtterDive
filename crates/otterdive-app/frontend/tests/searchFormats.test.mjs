import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "esbuild";
import { Range } from "monaco-editor/editor/common/core/range.js";
import { SearchParams, TextModelSearch } from "monaco-editor/editor/common/model/textModelSearch.js";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "findCurrent", "findOpenDocuments", "setSearchResults", "modelMatches", "matchAllowed",
  "activeSearchSelectionRange", "rangeContainsRange", "comparePosition", "isWordChar",
  "getSearchMode", "editorSearchQuery", "translateExtended", "currentSearchPatternError",
  "currentSearchSignature", "selectionSignature", "initialSearchResultIndex", "searchDirection",
  "findNextResult", "findPreviousResult", "navigateSearchResult", "navigateMarkdownSearch",
  "flattenSearchResults", "flattenSearchReport", "openSearchResult", "renderCurrentFindCount",
  "markdownSearchOptions", "markdownMatchesToDto",
]);
const handlers = ts.transpileModule(
  ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    .map(node => node.getText(ast)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

// Bundle the shipped Markdown matcher rather than reproducing its regular expressions.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../vendor/marktext-muya/src/utils/search.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { matchString } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const noop = () => {};

function textModel(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const withEol = (value, preference = 0) => value.replace(/\r\n|\r|\n/g,
    preference === 1 ? "\n" : preference === 2 ? "\r\n" : eol);
  const starts = [0, ...Array.from(text.matchAll(/\r\n|\r|\n/g), match => match.index + match[0].length)];
  const lines = text.split(/\r\n|\r|\n/);
  const getPositionAt = offset => {
    const index = starts.findLastIndex(start => start <= offset);
    return { lineNumber: index + 1, column: offset - starts[index] + 1 };
  };
  const getOffsetAt = ({ lineNumber, column }) => starts[lineNumber - 1] + column - 1;
  const model = {
    getValue: preference => withEol(text, preference),
    getEOL: () => eol,
    getLineContent: line => lines[line - 1],
    getPositionAt, getOffsetAt,
    getValueInRange: (range, preference) => withEol(text.slice(
      getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
      getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }),
    ), preference),
    findMatches(query, _scope, regex, matchCase, wordSeparators, captureMatches, limit) {
      const end = getPositionAt(text.length);
      return TextModelSearch.findMatches(model, new SearchParams(query, regex, matchCase, wordSeparators),
        new Range(1, 1, end.lineNumber, end.column), captureMatches, limit);
    },
  };
  return model;
}

function setup({ text = "", query, mode = "literal", matchCase = false, wholeWord = false, files = [{ name: "sample.txt", text }] }) {
  const controls = new Map();
  const input = id => {
    if (!controls.has(id)) controls.set(id, {
      value: "", checked: false, textContent: "", classList: { add: noop, remove: noop },
      querySelectorAll: () => [], matches() { return this.checked; },
    });
    return controls.get(id);
  };
  input("findInput").value = query;
  input("matchCaseInput").checked = matchCase;
  input("wholeWordInput").checked = wholeWord;
  const docs = files.map(({ name, text }, index) => ({
    id: index + 1, title: name, path: `/fixtures/${name}`, encoding: "UTF-8", model: textModel(text),
  }));
  const visits = [];
  const context = vm.createContext({
    monaco: { Range },
    $: input,
    document: { querySelector: () => ({ value: mode }) },
    state: {
      documents: docs, searchRevision: 0, results: null, searchScope: null,
      activeResultIndex: -1, searchResultHistory: [],
    },
    currentSearchSelectionDocumentId: 0, currentSearchSelection: null,
    searchResultNavigationDepth: 0,
    activeDocument: () => docs[0],
    ensureDocumentModel: doc => doc.model,
    documentVersion: () => 1,
    editor: { getSelection: () => null, revealPositionInCenter: noop },
    isMarkdownWysiwygActive: () => false,
    isReadingDocument: () => false,
    isSideEditorActive: () => false,
    markdownEditor: null,
    syncMarkdownModelFromEditor: noop,
    searchAllOpenFilesEnabled: () => input("allOpenFilesInput").checked,
    openResult: async (path, line, column) => {
      visits.push({ path, line, column });
      return docs.find(doc => doc.path === path);
    },
    setCurrentFindError: message => { input("currentFindInput").error = message; },
    resetSearchResults: () => { context.state.results = null; },
    commitSearchHistory: noop,
    resetResultAnalysis: noop,
    renderSearchSidebarResults: noop,
    renderSearchDecorations: noop,
    scrollActiveResultIntoView: noop,
    openBottomResults: noop,
    addSearchResultHistory: history => history,
    cancelScheduledCurrentFind: noop,
    rerunSearchForNavigation: () => assert.fail("unchanged search should reuse its results"),
    log: noop,
  });
  vm.runInContext(handlers, context);
  return { context, input, docs, visits };
}

const formats = [
  { name: "guide.md", text: "# Search 中文 😀\r\n\r\n正常 Alpha alphabet ALPHA\r\nnext\tline\r\n" },
  { name: "notes.txt", text: "Search 中文 😀\r\n正常 Alpha alphabet ALPHA\r\nnext\tline\r\n" },
  { name: "server.log", text: "[INFO] Search 中文 😀\r\n[INFO] 正常 Alpha alphabet ALPHA\r\nnext\tline\r\n" },
  { name: "data.json", text: "{\r\n  \"message\": \"正常 中文 😀 Alpha alphabet ALPHA\"\r\n}\r\n" },
  { name: "table.csv", text: "status,message,icon\r\n正常 中文,Alpha alphabet ALPHA,😀\r\n" },
  { name: "data.xml", text: "<root>\r\n  <message>正常 中文 😀 Alpha alphabet ALPHA</message>\r\n</root>\r\n" },
  { name: "config.yaml", text: "message: 正常 中文 😀\r\nwords: Alpha alphabet ALPHA\r\n" },
  { name: "script.py", text: "# 正常 中文 😀\r\nmessage = \"Alpha alphabet ALPHA\"\r\n" },
  { name: "script.js", text: "// 正常 中文 😀\r\nconst message = \"Alpha alphabet ALPHA\";\r\n" },
];

for (const file of formats) {
  test(`${file.name}: literal Chinese and emoji preserve CRLF offsets and UTF-16 columns`, () => {
    for (const query of ["中文", "😀"]) {
      const h = setup({ files: [file], query });
      h.context.findCurrent(false, false, false);
      const report = h.context.state.results;
      const matches = report.hits[0].matches;
      const offset = file.text.indexOf(query);
      const before = file.text.slice(0, offset).split("\r\n");
      assert.equal(report.total, 1);
      assert.equal(matches[0].start, offset);
      assert.equal(matches[0].end, offset + query.length);
      assert.equal(matches[0].line, before.length);
      assert.equal(matches[0].column, before.at(-1).length + 1);
      assert.equal(matches[0].matchedText, query);
      assert.equal(h.input("currentFindCount").textContent, "1/1");
    }
  });

  test(`${file.name}: case, whole-word and regex options yield consistent reports`, () => {
    for (const scenario of [
      { query: "alpha", total: 3 },
      { query: "Alpha", matchCase: true, total: 1 },
      { query: "alpha", wholeWord: true, total: 2 },
      { query: "Alpha|ALPHA", mode: "regex", matchCase: true, total: 2 },
      { query: "(?<=A)lpha", mode: "regex", matchCase: true, total: 1 },
    ]) {
      const h = setup({ files: [file], ...scenario });
      h.context.findCurrent(false, false, false);
      assert.equal(h.context.state.results.total, scenario.total, JSON.stringify(scenario));
      assert.equal(h.context.state.results.hits[0].matches.length, scenario.total);
      assert.equal(h.input("currentFindCount").textContent, `1/${scenario.total}`);
    }
  });
}

test("all-open search includes every common format and ignores the current selection", () => {
  const h = setup({ files: [...formats, { name: "empty.txt", text: "nothing to find" }], query: "alpha", wholeWord: true });
  h.input("allOpenFilesInput").checked = true;
  h.input("searchSelectionInput").checked = true;
  h.context.editor.getSelection = () => new Range(1, 1, 1, 2);
  h.context.findOpenDocuments(false, false, false);
  assert.equal(h.context.state.results.total, 18);
  assert.equal(h.context.state.results.hits.length, 9);
  assert.deepEqual(Array.from(h.context.state.results.hits, hit => hit.fileName), formats.map(file => file.name));
  assert.equal(h.input("currentFindCount").textContent, "18 个结果 · 9 文件");
});

test("multi-file navigation crosses Markdown and plain-text files while retaining the global count", async () => {
  const h = setup({
    files: [{ name: "first.md", text: "# 正常\r\n正常" }, { name: "second.txt", text: "😀 正常" }],
    query: "正常",
  });
  h.input("allOpenFilesInput").checked = true;
  h.context.findOpenDocuments(false, false, true);
  await Promise.resolve();
  await h.context.findNextResult();
  await h.context.findNextResult();
  assert.deepEqual(h.visits.map(visit => [visit.path, visit.line, visit.column]), [
    ["/fixtures/first.md", 1, 3], ["/fixtures/first.md", 2, 1], ["/fixtures/second.txt", 1, 4],
  ]);
  assert.equal(h.input("currentFindCount").textContent, "3/3 · 2 文件");
  await h.context.findNextResult();
  assert.equal(h.visits.length, 3);
  await h.context.findPreviousResult();
  assert.equal(h.context.state.activeResultIndex, 1);
  assert.equal(h.input("currentFindCount").textContent, "2/3 · 2 文件");
});

test("extended search treats CRLF as a single line break and preserves multiline result ranges", () => {
  const h = setup({ text: "before\r\n正常\r\nnext\tline\r\nafter", query: "正常\\nnext\\tline", mode: "extended" });
  h.context.findCurrent(false, false, false);
  const match = h.context.state.results.hits[0].matches[0];
  assert.equal(h.context.state.results.total, 1);
  assert.equal(match.line, 2);
  assert.equal(match.column, 1);
  assert.equal(match.start, 8);
  assert.equal(match.end, 21);
  assert.equal(match.matchedText, "正常\r\nnext\tline");
});

test("selection search includes only complete matches inside the selected multiline range", () => {
  const h = setup({ text: "正常 before\r\n正常 chosen\r\n正常 after", query: "正常" });
  h.input("searchSelectionInput").checked = true;
  h.context.editor.getSelection = () => new Range(2, 1, 3, 2);
  h.context.findCurrent(false, false, false);
  assert.equal(h.context.state.results.total, 1);
  assert.equal(h.context.state.results.hits[0].matches[0].line, 2);
});

test("reverse navigation starts at the last result, stops at boundaries and wraps only when enabled", async () => {
  const h = setup({ text: "正常\r\n正常\r\n正常", query: "正常" });
  h.input("reverseSearchInput").checked = true;
  h.context.findCurrent(false, false, false);
  assert.equal(h.context.state.activeResultIndex, 2);
  await h.context.findNextResult();
  await h.context.findNextResult();
  await h.context.findNextResult();
  assert.deepEqual(h.visits.map(visit => visit.line), [2, 1]);
  assert.equal(h.context.state.activeResultIndex, 0);
  h.input("wrapSearchInput").checked = true;
  h.context.state.searchSignature = h.context.currentSearchSignature("current");
  await h.context.findNextResult();
  assert.equal(h.context.state.activeResultIndex, 2);
  await h.context.findPreviousResult();
  assert.equal(h.context.state.activeResultIndex, 0);
  assert.equal(h.input("currentFindCount").textContent, "1/3");
});

for (const scenario of [
  { name: "standalone Chinese words", text: "正常 异常 正常状态", query: "正常", offsets: [0] },
  { name: "Chinese neighbors, underscores, hyphens and digits", text: "中文Alpha Alpha中 Alpha_ Alpha- Alpha1 (Alpha)", query: "Alpha", offsets: [22, 37] },
  { name: "regex alternatives", text: "catapult bobcat cat bob", query: "cat|bob", mode: "regex", offsets: [16, 20] },
  { name: "astral Unicode letter and number neighbors", text: "𐐀Alpha Alpha𐐀 𝟘Alpha Alpha𝟘 Alpha- (Alpha)", query: "Alpha", offsets: [32, 40] },
]) {
  test(`whole-word search agrees between Markdown and source: ${scenario.name}`, () => {
    const h = setup({ ...scenario, wholeWord: true, matchCase: true });
    const sourceMatches = h.context.modelMatches(h.docs[0]);
    const markdownMatches = matchString(scenario.text, scenario.query, {
      isWholeWord: true, isCaseSensitive: true, isRegexp: scenario.mode === "regex",
    });
    assert.deepEqual(Array.from(sourceMatches, match => match.start), scenario.offsets, "source search boundaries");
    assert.deepEqual(markdownMatches.map(match => match.index), scenario.offsets, "Markdown search boundaries");
  });
}

test("invalid and empty-matching expressions clear prior reports", () => {
  for (const query of ["(", "(?:)"]) {
    const h = setup({ text: "Alpha", query, mode: "regex" });
    h.context.state.results = { total: 1, hits: [] };
    h.context.findCurrent(false, false, false);
    assert.equal(h.context.state.results, null);
    assert.match(h.input("currentFindInput").error, /正则表达式/);
  }
});
