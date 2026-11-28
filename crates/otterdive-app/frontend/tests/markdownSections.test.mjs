import assert from "node:assert/strict";
import test from "node:test";
import { MarkdownSectionReader, sectionMarkdown, sectionOptions } from "../src/markdownSections.ts";

const source = { path: "/大文件.md", encoding: "UTF-8", revision: "r1" };
const index = {
  sections: [
    { title: "重复", level: 1, line: 1, start: 0, end: 64 },
    { title: "巨大", level: 1, line: 5, start: 64, end: 4096 },
    { title: "重复", level: 1, line: 10, start: 4096, end: 4130 },
  ],
  sectionLimit: 128,
  definitions: [{ offset: 18, text: "[ref]: /before" }, { offset: 4120, text: "[^注]: 之后的注" }],
};

function harness(render = async text => text) {
  const requests = [], cancelled = [], updates = [];
  function invoke(command, args) {
    if (command === "cancel_document_page") { cancelled.push(args.requestId); return Promise.resolve(); }
    return new Promise((resolve, reject) => requests.push({ command, args, resolve, reject }));
  }
  const reader = new MarkdownSectionReader(source, invoke, render, html => updates.push(html));
  return { reader, requests, cancelled, updates };
}

test("preserves the order and once-only inclusion of cross-section definitions", () => {
  assert.equal(sectionMarkdown("first", index.sections[0], index), "first\n\n[^注]: 之后的注");
  assert.equal(sectionMarkdown("last", index.sections[2], index), "[ref]: /before\n\nlast");
});

test("navigates from the visible source line, skips oversize reads, recovers in adjacent sections", async () => {
  const h = harness();
  const opening = h.reader.open(7);
  h.requests[0].resolve(index);
  await opening;
  assert.equal(h.reader.position, 1);
  assert.equal(h.reader.anchors.get("重复"), 0);
  assert.equal(h.reader.anchors.get("重复-1"), 2);
  assert.match(h.reader.status, /256 KiB/);
  assert.equal(h.requests.length, 1);
  const tail = h.reader.select(2);
  assert.equal(h.requests[1].args.start, 4096);
  assert.equal(h.requests[1].args.request.revision, "r1");
  h.requests[1].resolve("tail");
  await tail;
  assert.equal(h.updates.at(-1), "[ref]: /before\n\ntail");
  assert.match(h.reader.status, /3 \/ 3.*源行 10/);
});

test("cancellation discards a late full-file index and a superseded render", async () => {
  let finishRender;
  const h = harness(() => new Promise(resolve => { finishRender = resolve; }));
  const opening = h.reader.open(0);
  h.reader.cancel();
  assert.deepEqual(h.cancelled, [h.requests[0].args.request.requestId]);
  h.requests[0].resolve(index);
  await opening;
  assert.equal(h.reader.index, null);
  h.reader.index = index;
  const pending = h.reader.select(0);
  h.requests[1].resolve("stale source");
  await new Promise(resolve => setImmediate(resolve));
  await h.reader.select(1);
  finishRender("<h1>stale</h1>");
  await pending;
  assert.equal(h.updates.includes("<h1>stale</h1>"), false);
  assert.match(h.reader.status, /256 KiB/);
});

test("cancelling a range read signals the native request and ignores its response", async () => {
  const h = harness();
  h.reader.index = index;
  const read = h.reader.select(2);
  h.reader.cancel();
  h.requests[0].resolve("stale");
  await read;
  assert.equal(h.cancelled[0], h.requests[0].args.request.requestId);
  assert.equal(h.reader.busy, false);
  assert.equal(h.updates.at(-1), "");
});

test("directory controls stay bounded and can find remote duplicate headings", () => {
  const sections = Array.from({ length: 8000 }, (_, i) => ({ title: i % 4000 === 0 ? "重复" : "章节", line: i + 1 }));
  assert.equal(sectionOptions(sections, 6000, "").length, 41);
  assert.deepEqual(sectionOptions(sections, 20, "重复"), [0, 4000]);
  assert.deepEqual(sectionOptions(sections, 0, "7999"), [7998]);
});
