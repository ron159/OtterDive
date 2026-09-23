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
