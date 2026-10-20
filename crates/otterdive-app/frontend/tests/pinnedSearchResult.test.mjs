import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["searchResultPinButton", "handleSearchResultPin", "renderPinnedSearchResult", "unpinSearchResult",
  "nativeResultsAvailable", "syncBottomResults", "openBottomResults", "closeBottomResults", "clearSearchResults",
  "resetSearchResults", "closeDocument", "bottomResultsMaxHeight"]);
const js = ts.transpileModule(ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const snapshotJs = ts.transpileModule(fs.readFileSync(new URL("../src/pinnedSearchResult.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/^export /gm, "");
const noop = () => {};

function setup() {
  const nodes = new Map();
  let focused;
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { textContent: "", title: "", scrollTop: 600, scrollLeft: 240,
        classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key),
          toggle(key, force) { if (force ?? !classes.has(key)) classes.add(key); else classes.delete(key); } },
        setAttribute: noop, focus: () => { focused = id; } });
    }
    return nodes.get(id);
  }
  const match = { line: 23, column: 7, lineText: '<script>snapshot & text</script>' };
  const report = { total: 1, hits: [{ path: "/one/same.txt", fileName: "same.txt", matches: [match] }] };
  const state = { pinnedSearchResult: null, documents: [{ id: 1, path: "/one/same.txt" }, { id: 2, path: "/two/same.txt" }],
    activeId: 2, results: report, searchResultHistory: [], replacePreview: null, workspaceSearchStatus: "idle" };
  const context = { state, analysedRows: null, activeBottomResultTool: "search", analyseResultsAvailable: true,
    $: node, iconSvg: () => "<svg></svg>", fileNameFromPath: path => path.split(/[\\/]/).pop(),
    workspaceSearchIsBusy: () => false, requestEditorLayout: noop, setBottomResultsHeight: noop,
    MIN_BOTTOM_RESULTS_HEIGHT: 160, window: { requestAnimationFrame: noop, innerWidth: 1024, innerHeight: 640 }, analysePanel: null, focusActiveEditor: () => { focused = "editor"; },
    resetResultAnalysis: () => { context.analysedRows = null; }, renderSearchSidebarResults: noop,
    searchDecorations: null, activeSearchDecoration: null, markdownEditor: null, setCurrentFindError: noop,
    renderCurrentFindCount: noop, log: noop,
    confirmDocumentCanClose: async () => true, rememberMarkdownLocation: noop, rememberClosedDocument: noop,
    discardRecovery: noop, writingStatsCache: new Map(), closeSideEditorFor: noop, cancelAutoSave: noop,
    disposeMarkdownEditor: noop, markdownSessions: new Map(), cancelDocumentSizeUpdate: noop,
    activateDocument: id => { state.activeId = id; }, renderAll: noop, scheduleSessionSave: noop,
  };
  vm.createContext(context);
  vm.runInContext(snapshotJs, context);
  vm.runInContext(js, context);
  function pin(dataset) {
    let prevented = false, stopped = false;
    context.handleSearchResultPin({ target: { closest: () => ({ dataset }) },
      preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
  }
  return { context, state, report, match, node, pin, focused: () => focused };
}

test("Pin owns a read-only snapshot with exact file, line, column and text and does not navigate", () => {
  const h = setup();
  h.pin({ pinResultIndex: "0" });
  const snapshot = h.state.pinnedSearchResult;
  assert.equal(snapshot.path, "/one/same.txt");
  assert.equal(snapshot.fileName, "same.txt");
  assert.equal(snapshot.line, 23);
  assert.equal(snapshot.column, 7);
  assert.equal(h.node("pinnedSearchText").textContent, h.match.lineText);
  assert.equal(h.node("pinnedSearchPath").textContent, "/one/same.txt");
  assert.equal(h.node("pinnedSearchLocation").textContent, "第 23 行 · 第 7 列");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(h.state.activeId, 2);
  h.match.lineText = "modified after pin";
  h.report.hits[0].path = "/renamed/file.txt";
  h.context.renderPinnedSearchResult();
  assert.equal(snapshot.text, '<script>snapshot & text</script>');
  assert.equal(snapshot.path, "/one/same.txt");
});

test("pinning preserves both result scroll axes; repeated Pin is idempotent and a new Pin replaces it", () => {
  const h = setup();
  const body = h.node("findResultsBody");
  h.pin({ pinResultIndex: "0" });
  const first = h.state.pinnedSearchResult;
  h.pin({ pinResultIndex: "0" });
  assert.equal(h.state.pinnedSearchResult, first);
  h.match.line = 80;
  h.match.lineText = "replacement snapshot";
  h.pin({ pinResultIndex: "0" });
  assert.notEqual(h.state.pinnedSearchResult, first);
  assert.equal(h.node("pinnedSearchText").textContent, "replacement snapshot");
  assert.equal(body.scrollTop, 600);
  assert.equal(body.scrollLeft, 240);
});

test("historical and filtered results use their own provenance rather than current result indices", () => {
  const h = setup();
  h.state.searchResultHistory = [{ id: 42, report: { hits: [
    { path: "/old/other.txt", fileName: "other.txt", matches: [{ line: 91, column: 3, lineText: "old result" }] },
  ] } }];
  h.pin({ pinResultIndex: "0", pinSearchBatchId: "42" });
  assert.equal(h.state.pinnedSearchResult.path, "/old/other.txt");
  assert.equal(h.state.pinnedSearchResult.text, "old result");
  h.context.analysedRows = [{ path: "/filtered/another.txt", line: 38, column: 2, text: "capture result" }];
  h.pin({ pinAnalysisRow: "0" });
  assert.equal(h.state.pinnedSearchResult.fileName, "another.txt");
  assert.equal(h.state.pinnedSearchResult.path, "/filtered/another.txt");
  assert.equal(h.state.pinnedSearchResult.text, "capture result");
});

test("switching Search/Analyse columns, clearing result history and closing the dock preserve Pin", () => {
  const h = setup();
  h.pin({ pinResultIndex: "0" });
  const pin = h.state.pinnedSearchResult;
  h.context.openBottomResults("analyse");
  assert.equal(h.node("searchResultsPane").classList.contains("hidden"), true);
  assert.equal(h.node("pinnedSearchComparison").classList.contains("hidden"), false);
  h.context.clearSearchResults();
  assert.equal(h.state.pinnedSearchResult, pin);
  assert.equal(h.state.results, null);
  assert.equal(h.context.nativeResultsAvailable(), true);
  h.context.closeBottomResults();
  h.context.openBottomResults("search");
  assert.equal(h.node("pinnedSearchText").textContent, pin.text);
  assert.equal(h.node("pinnedSearchComparison").classList.contains("hidden"), false);
});

test("closing a source tab keeps the snapshot and does not retarget a different file of the same name", async () => {
  const h = setup();
  h.pin({ pinResultIndex: "0" });
  assert.equal(await h.context.closeDocument(1), true);
  h.context.syncBottomResults();
  assert.equal(h.state.documents.length, 1);
  assert.equal(h.state.documents[0].path, "/two/same.txt");
  assert.equal(h.state.pinnedSearchResult.path, "/one/same.txt");
  assert.equal(h.node("pinnedSearchPath").textContent, "/one/same.txt");
});

test("unpin clears only the snapshot, restores focus and works when no search results remain", () => {
  const h = setup();
  h.pin({ pinResultIndex: "0" });
  h.context.unpinSearchResult();
  assert.equal(h.state.pinnedSearchResult, null);
  assert.equal(h.state.results, h.report);
  assert.equal(h.node("pinnedSearchComparison").classList.contains("hidden"), true);
  assert.equal(h.node("pinnedSearchText").textContent, "");
  assert.equal(h.focused(), "bottomSearchResultsTab");
  h.pin({ pinResultIndex: "0" });
  h.context.clearSearchResults();
  h.context.analyseResultsAvailable = false;
  h.context.unpinSearchResult();
  assert.equal(h.node("bottomResultsDock").classList.contains("hidden"), true);
  assert.equal(h.focused(), "editor");
});

test("stale or missing results cannot replace a valid snapshot and native Pin buttons work independently", () => {
  const h = setup();
  h.pin({ pinResultIndex: "0" });
  const pin = h.state.pinnedSearchResult;
  h.pin({ pinResultIndex: "-1" });
  h.pin({ pinResultIndex: "0", pinSearchBatchId: "missing" });
  h.pin({ pinAnalysisRow: "0" });
  assert.equal(h.state.pinnedSearchResult, pin);
  const markup = h.context.searchResultPinButton(5, 23, 42);
  assert.match(markup, /<button[^>]*type="button"/);
  assert.match(markup, /aria-label="固定第 23 行用于对比"/);
  assert.match(markup, /data-pin-search-batch-id="42"/);
});

test("comparison lives outside the scrolling and swappable panes and is excluded from session persistence", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const comparison = html.indexOf('id="pinnedSearchComparison"');
  assert.ok(comparison > html.indexOf('id="bottomResultsDock"'));
  assert.ok(comparison < html.indexOf('class="bottom-results-content"'));
  const snapshot = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "saveSession");
  assert.ok(snapshot);
  assert.doesNotMatch(snapshot.getText(ast), /pinnedSearchResult/);
});

test("a compact window reserves enough result area when the comparison is pinned", () => {
  const h = setup();
  assert.equal(h.context.bottomResultsMaxHeight(), 204);
  h.pin({ pinResultIndex: "0" });
  assert.equal(h.context.bottomResultsMaxHeight(), 320);
});
