import assert from "node:assert/strict";
import test from "node:test";
import { anchorSelection, resolveAnchor, textSignature, AnnotationStore, markdownExcerpts } from "../src/readingAnnotations.ts";

function index(parts) {
  let text = "";
  const sections = [];
  for (const [id, content] of parts) {
    sections.push({ id, label: id, start: text.length });
    text += content;
  }
  return { text, sections, signature: textSignature(text) };
}

test("chapter and surrounding text locate an excerpt after edits", () => {
  const before = index([["one", "other quote\n"], ["two", "left quote right\n"]]);
  const start = before.text.lastIndexOf("quote");
  const anchor = anchorSelection(before, start, start + 5);
  const after = index([["one", "other quote\n"], ["two", "new quote elsewhere\nleft quote right\n"]]);
  assert.deepEqual(resolveAnchor(after, anchor), { status: "matched", start: after.text.lastIndexOf("quote") });
  assert.equal(resolveAnchor(index([["one", "other quote\n"], ["two", "gone"]]), anchor).status, "missing");
});

test("an exact original location survives restart, while indistinguishable new matches stay ambiguous", () => {
  const phrase = "a".repeat(48) + "quote" + "b".repeat(48);
  const before = index([["chapter", phrase.repeat(2)]]);
  const start = before.text.lastIndexOf("quote");
  const anchor = JSON.parse(JSON.stringify(anchorSelection(before, start, start + 5)));
  assert.deepEqual(resolveAnchor(before, anchor), { status: "matched", start });
  assert.deepEqual(resolveAnchor(index([["chapter", phrase.repeat(3)]]), anchor), { status: "ambiguous", count: 3 });
});

test("a renamed chapter can be recovered by its quote and context", () => {
  const before = index([["old", "before target after"]]);
  const anchor = anchorSelection(before, 7, 13);
  assert.equal(resolveAnchor(index([["new", "some before target after"]]), anchor).status, "matched");
  assert.equal(resolveAnchor(index([["new", "another target elsewhere"]]), anchor).status, "missing");
});

test("repeated heading IDs may shift after edits; identical context remains ambiguous", () => {
  const body = "x".repeat(60) + "quote" + "y".repeat(60);
  const original = index([["topic", body], ["topic-1", body]]);
  original.sections.forEach(s => s.label = "Topic");
  const start = original.text.lastIndexOf("quote");
  const anchor = anchorSelection(original, start, start + 5);
  const revised = index([["topic", body], ["topic-1", body], ["topic-2", body]]);
  revised.sections.forEach(s => s.label = "Topic");
  assert.deepEqual(resolveAnchor(revised, anchor), { status: "ambiguous", count: 3 });
});

test("a missing chapter reports multiple possible quotes even if neither has original context", () => {
  const original = index([["old", "before target after"]]);
  const anchor = anchorSelection(original, 7, 13);
  assert.deepEqual(resolveAnchor(index([["new", "a target and a target"]]), anchor), { status: "ambiguous", count: 2 });
});

test("store survives restart, merges moved files and preserves state on write failure", () => {
  let value = null, full = false;
  const disk = { getItem: () => value, setItem: (_, next) => { if (full) throw Error("quota"); value = next; } };
  const store = new AnnotationStore(() => disk);
  const anchor = anchorSelection(index([["s", "a quote"]]), 2, 7);
  const item = { id: "a", key: "file:/old/doc.md", anchor, note: "hello" };
  store.put(item);
  store.put({ ...item, id: "b", key: "file:/new/doc.md" });
  store.remap(key => key.replace("/old/", "/new/"));
  const restarted = new AnnotationStore(() => disk);
  assert.deepEqual(restarted.list("file:/new/doc.md").map(i => i.id), ["a", "b"]);
  full = true;
  assert.throws(() => restarted.remove("a"), /quota/);
  assert.equal(restarted.list("file:/new/doc.md").length, 2);
  full = false;
  restarted.put({ ...restarted.list("file:/new/doc.md")[0], note: "edited" });
  restarted.remove("b");
  assert.deepEqual(new AnnotationStore(() => disk).list("file:/new/doc.md").map(i => i.note), ["edited"]);
});

test("export includes multiline excerpts, notes and unresolved provenance", () => {
  const anchor = anchorSelection(index([["chapter", "hello\nworld"]]), 0, 11);
  const output = markdownExcerpts("doc.md", [{ anchor, note: "one\ntwo", resolution: { status: "missing" } }]);
  assert.match(output, /> hello\n> world/);
  assert.match(output, /one/); assert.match(output, /two/);
  assert.match(output, /chapter/); assert.match(output, /原文失效/);
});
