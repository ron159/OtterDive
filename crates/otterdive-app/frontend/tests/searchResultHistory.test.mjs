import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const history = await loadTypeScriptModule("../src/searchResultHistory.ts");
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("keeps earlier search batches collapsed when a new search is added", () => {
  const firstReport = { total: 2 };
  const secondReport = { total: 5 };

  const first = history.addSearchResultHistory([], "alpha", "current", firstReport);
  const second = history.addSearchResultHistory(first, "beta", "open", secondReport);

  assert.deepEqual(
    second.map(({ query, scope, report, expanded }) => ({ query, scope, report, expanded })),
    [
      { query: "alpha", scope: "current", report: firstReport, expanded: false },
      { query: "beta", scope: "open", report: secondReport, expanded: true },
    ],
  );
  assert.notEqual(second[0].id, second[1].id);
});

test("expands and collapses any retained search batch independently", () => {
  const first = history.addSearchResultHistory([], "alpha", "current", { total: 2 });
  const second = history.addSearchResultHistory(first, "beta", "workspace", { total: 5 });

  const expanded = history.toggleSearchResultHistory(second, second[0].id);
  assert.equal(expanded[0].expanded, true);
  assert.equal(expanded[1].expanded, true);

  const collapsed = history.toggleSearchResultHistory(expanded, expanded[1].id);
  assert.equal(collapsed[0].expanded, true);
  assert.equal(collapsed[1].expanded, false);
});

test("renders history with accessible toggles and direct result navigation", () => {
  assert.match(mainSource, /aria-expanded="\$\{String\(entry\.expanded\)\}"/);
  assert.match(mainSource, /toggleSearchResultHistory\(state\.searchResultHistory, batchId\)/);
  assert.match(mainSource, /openHistoricalSearchResult\(batchId, resultIndex\)/);
  assert.match(stylesSource, /\.find-result-history-toggle\s*\{/);
  assert.match(stylesSource, /\.find-result-history-list\s*\{/);
});

async function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("keeps only the five most recent result snapshots", () => {
  let entries = [];
  for (let i = 0; i < 20; i++) entries = history.addSearchResultHistory(entries, String(i), "workspace", { total: 1 });
  assert.deepEqual(entries.map(entry => entry.query), ["15", "16", "17", "18", "19"]);
  assert.equal(new Set(entries.map(entry => entry.id)).size, 5);
});
