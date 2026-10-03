import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
const source = fs.readFileSync(new URL("../src/markdownLinkSuggestions.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { markdownLinkCompletionContext, headingLinkSuggestions } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("completion replaces only destination text for inline and reference links", () => {
  for (const line of ["read [guide](./gui", "![picture](<assets/a", "[guide]: <docs/intro"]) {
    const context = markdownLinkCompletionContext(line);
    assert.ok(context);
    assert.equal(line.slice(context.start), context.value);
    assert.equal(context.value.includes("<"), false);
  }
});

test("ordinary words, completed links and titles do not trigger path suggestions", () => {
  for (const line of ["an ordinary paragraph", "[guide](guide.md)", "[guide](guide.md \"title", "[guide](<guide.md>"]) {
    assert.equal(markdownLinkCompletionContext(line), null);
  }
});

test("heading suggestions retain the file path and use actual unique rendered IDs", () => {
  const headings = [{ id: "标题", text: "标题" }, { id: "标题-1", text: "标题" }, { id: "other", text: "Other" }];
  const results = headingLinkSuggestions("../guide.md#%E6%A0%87", headings);
  assert.equal(results.length, 2);
  assert.equal(results[0].text, "../guide.md#%E6%A0%87%E9%A2%98");
  assert.equal(results[1].text, "../guide.md#%E6%A0%87%E9%A2%98-1");
});

test("self anchors, formatted titles and incomplete percent escapes are safe", () => {
  assert.equal(headingLinkSuggestions("#int", [{ id: "intro", text: "Introduction" }])[0].text, "#intro");
  assert.equal(headingLinkSuggestions("#", [{ id: "some-id", text: "Formatted title" }])[0].text, "#some-id");
  assert.doesNotThrow(() => headingLinkSuggestions("#%E", [{ id: "intro", text: "Introduction" }]));
  assert.deepEqual(headingLinkSuggestions("guide.md", []), []);
});
