import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const renderer = ast.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === "renderProgressiveSearchResults"
);
assert.ok(renderer);
const javascript = ts.transpileModule(renderer.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

test("renders every ordinary search result beyond the former 400-row limit", () => {
  class Element {
    children = [];
    dataset = {};
    isConnected = true;
    appendChild(child) { this.children.push(child); }
    set innerHTML(value) {
      this.html = value;
      if (value.includes("<header>")) this.lastElementChild = new Element();
    }
  }

  const frames = [];
  const report = {
    total: 1001,
    hits: [
      { path: "first.txt", fileName: "first.txt", matches: Array.from({ length: 501 }, (_, index) => ({ line: index + 1, column: 1 })) },
      { path: "second.txt", fileName: "second.txt", matches: Array.from({ length: 500 }, (_, index) => ({ line: index + 1, column: 1 })) },
    ],
  };
  const list = new Element();
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    window: { requestAnimationFrame: callback => frames.push(callback) },
    performance: { now: () => 0 },
    state: { results: report, activeResultIndex: 0 },
    searchResultRenderVersion: 1,
    iconSvg: () => "",
    escapeAttr: value => value,
    escapeHtml: value => value,
    highlightMatchLine: () => "preview",
  });
  vm.runInContext(javascript, context);
  context.renderProgressiveSearchResults(report, list, 1);
  while (frames.length) frames.shift()();

  const rows = list.children.flatMap(group => group.lastElementChild.children);
  assert.equal(rows.length, report.total);
  assert.equal(rows[0].dataset.resultIndex, "0");
  assert.equal(rows.at(-1).dataset.resultIndex, "1000");
  assert.equal(list.children.length, 2);
  assert.equal(list.dataset.currentSearchResults, "true");
});

test("clicking a result keeps the results scroll position while navigating to its document", async () => {
  const navigate = ast.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === "openSearchResult"
  );
  assert.ok(navigate);
  const navigationJavaScript = ts.transpileModule(navigate.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const active = new Set(["result-active"]);
  const selected = new Set();
  const rows = [active, selected].map(classes => ({
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
    },
  }));
  const body = {
    scrollTop: 800,
    querySelectorAll: selector => {
      const index = Number(selector.match(/data-result-index="(\d+)"/)?.[1] ?? -1);
      return rows[index] ? [rows[index]] : [];
    },
  };
  let resultScrolls = 0;
  const context = vm.createContext({
    searchResultNavigationDepth: 0,
    state: { activeResultIndex: 0, searchScope: "workspace" },
    flattenSearchResults: () => [
      { path: "first.txt", match: { line: 1, column: 1 } },
      { path: "second.txt", match: { line: 200, column: 1 } },
    ],
    $: id => id === "findResultsBody" ? body : { checked: false },
    renderCurrentFindCount: () => {},
    renderSearchSidebarResults: () => { body.scrollTop = 0; },
    isReadingDocument: () => false,
    isMarkdownWysiwygActive: () => false,
    renderSearchDecorations: () => {},
    scrollActiveResultIntoView: () => { resultScrolls += 1; },
    openResult: async () => {
      // Switching files normally re-renders the sidebar through renderRightSidebar.
      if (vm.runInContext("searchResultNavigationDepth", context) === 0) body.scrollTop = 0;
      return {};
    },
  });
  vm.runInContext(navigationJavaScript, context);

  await context.openSearchResult(1, false);
  assert.equal(body.scrollTop, 800);
  assert.equal(resultScrolls, 0);
  assert.equal(active.has("result-active"), false);
  assert.equal(selected.has("result-active"), true);
  assert.equal(context.state.activeResultIndex, 1);
  assert.equal(vm.runInContext("searchResultNavigationDepth", context), 0);
});
