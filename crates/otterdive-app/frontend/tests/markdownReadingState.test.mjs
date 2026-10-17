import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/markdownNavigation.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/^export /gm, "");
const context = vm.createContext({});
vm.runInContext(code + "\nglobalThis.api = { MarkdownHistory, normalizeMarkdownLocations };", context);
const { MarkdownHistory, normalizeMarkdownLocations } = context.api;
const entry = (key, line = 1) => ({ key, path: key, location: { mode: "reading", line, column: 1, cursor: null, scroll: { headingIndex: 2, offsetPx: 12, fraction: 0.4, sectionFraction: 0.2 } } });

test("back and forward retain exact reading anchors and branching discards forward history", () => {
  const history = new MarkdownHistory();
  history.record(entry("a.md", 5));
  history.record(entry("b.md", 8));
  assert.equal(history.back(entry("c.md", 12)).key, "b.md");
  assert.equal(history.back(entry("b.md", 8)).location.line, 5);
  const next = history.forward(entry("a.md", 5));
  assert.equal(next.key, "b.md");
  assert.equal(next.location.scroll.sectionFraction, 0.2);
  history.record(entry("b.md", 8));
  assert.equal(history.forward(entry("d.md")), null);
});

test("failed navigation can be rolled back without losing either history stack", () => {
  const history = new MarkdownHistory();
  history.record(entry("a.md"));
  history.back(entry("b.md"));
  const snapshot = history.snapshot();
  history.forward(entry("a.md"));
  history.restore(snapshot);
  assert.equal(history.forward(entry("a.md")).key, "b.md");
});

test("reading positions survive JSON roundtrip while malformed or excessive state is rejected", () => {
  const raw = { "a.md": entry("a.md").location, invalid: { mode: "reading", scroll: { fraction: Infinity } }, "__proto__": null };
  const locations = normalizeMarkdownLocations(JSON.parse(JSON.stringify(raw)));
  assert.equal(locations["a.md"].scroll.sectionFraction, 0.2);
  assert.equal(locations.invalid, undefined);
  const huge = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`${i}.md`, entry(`${i}.md`).location]));
  assert.equal(Object.keys(normalizeMarkdownLocations(huge)).length, 200);
});

test("history is bounded and rename remaps both navigation directions", () => {
  const history = new MarkdownHistory(3);
  for (let i = 0; i < 5; i++) history.record(entry(`old/${i}.md`));
  history.back(entry("old/current.md"));
  history.remap(item => ({ ...item, key: item.key.replace("old/", "new/"), path: item.path.replace("old/", "new/") }));
  assert.equal(history.forward(entry("new/4.md")).key, "new/current.md");
  assert.equal(history.back(entry("new/current.md")).key, "new/4.md");
  assert.equal(history.back(entry("new/4.md")).key, "new/3.md");
  assert.equal(history.back(entry("new/3.md")).key, "new/2.md");
  assert.equal(history.back(entry("new/2.md")), null);
});
