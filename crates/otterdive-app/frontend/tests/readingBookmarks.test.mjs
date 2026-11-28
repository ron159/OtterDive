import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/readingBookmarks.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { normalizeReadingBookmarks, moveReadingBookmarks } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const first = { anchor: "title", name: "First" };
const second = { anchor: "title-1", name: "Second" };

test("old sessions and line bookmark data do not create heading bookmarks", () => {
  for (const value of [undefined, null, [], { "file:/book.md": [2, 42] }]) {
    assert.deepEqual(Object.keys(normalizeReadingBookmarks(value)), []);
  }
});

test("restores distinct duplicate headings and ignores invalid or repeated records", () => {
  const input = { "file:/book.md": [first, null, { name: 2 }, { ...second, name: "  Second  " }, { ...first, name: "duplicate" }],
    "draft:book": [second], "file:/other.md": [second], junk: [first] };
  const output = normalizeReadingBookmarks(JSON.parse(JSON.stringify(input)));
  assert.deepEqual({ ...output }, { "file:/book.md": [first, second], "draft:book": [second], "file:/other.md": [second] });
});

test("first save transfers draft bookmarks and Save As keeps independent copies", () => {
  const store = normalizeReadingBookmarks({ "draft:1": [first, second] });
  moveReadingBookmarks(store, "draft:1", "file:/source.md");
  assert.equal(store["draft:1"], undefined);
  moveReadingBookmarks(store, "file:/source.md", "file:/copy.md", true);
  store["file:/copy.md"][0].name = "Renamed copy";
  assert.deepEqual(store["file:/source.md"], [first, second]);
});
