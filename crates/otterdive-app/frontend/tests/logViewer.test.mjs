import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
const source = fs.readFileSync(new URL("../src/logViewerState.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { LOG_CHUNK_BYTES, LOG_WINDOW_BYTES, logChunkRequest, retainLogWindow, nextLogFollowAction, shouldPauseLogFollow } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
function chunk(text, startOffset, nextOffset, overrides = {}) {
  return { text, startOffset, nextOffset, size: nextOffset, identity: "file-1", revision: "r1", fingerprint: `fp-${nextOffset}`, reset: false, hasMore: false, encoding: "UTF-8", ...overrides };
}
test("paging uses byte offsets and fingerprints only the matching sequential cursor", () => {
  const cursor = chunk("中文", 500_000, 500_006, { size: 900_000 });
  const next = logChunkRequest("/logs/中文.log", "next", cursor, 500_000, "UTF-8");
  assert.equal(next.offset, 500_006);
  assert.equal(next.previousFingerprint, "fp-500006");
  assert.equal(next.previousSize, 900_000);
  const previous = logChunkRequest("/log", "previous", cursor, 500_000, "UTF-8");
  assert.equal(previous.offset, 500_000 - LOG_CHUNK_BYTES);
  assert.equal(previous.previousFingerprint, undefined);
  assert.equal(logChunkRequest("/log", "previous", cursor, 100, "UTF-8").offset, 0);
  const tail = logChunkRequest("/log", "end", cursor, 500_000, "UTF-8");
  assert.equal(tail.tail, true); assert.equal(tail.offset, undefined); assert.equal(tail.previousFingerprint, undefined);
});
test("editor encoding labels map to the native chunk reader", () => {
  for (const [input, expected] of [["UTF-8-BOM", "UTF-8 BOM"], ["UTF-16 Little Endian", "UTF-16 LE"], ["UTF-16 Big Endian", "UTF-16 BE"], ["GBK", "GBK"], ["Big5", "Big5"], ["Shift-JIS", "Shift-JIS"], ["Windows-1252", "Windows-1252"]]) {
    assert.equal(logChunkRequest("/log", "start", null, 0, input).encoding, expected);
  }
});
test("bounded windows discard complete old chunks without slicing emoji or inventing byte offsets", () => {
  const a = chunk("你🙂", 0, 7), b = chunk("好🙂", 7, 14), c = chunk("尾🙂", 14, 21);
  const kept = retainLogWindow([a, b], c, true, 12);
  assert.equal(kept.map(item => item.text).join(""), "好🙂尾🙂");
  assert.equal(kept[0].startOffset, 7); assert.equal(kept.at(-1).nextOffset, 21);
  assert.equal(kept.reduce((bytes, item) => bytes + item.text.length * 2, 0), 12);
});
test("rotation, truncation and noncontiguous jumps replace the window", () => {
  const previous = [chunk("old", 100, 103)];
  for (const incoming of [chunk("new", 0, 3, { reset: true }), chunk("new", 103, 106, { identity: "file-2" }), chunk("new", 200, 203)]) {
    assert.deepEqual(retainLogWindow(previous, incoming, true).map(item => item.text), ["new"]);
  }
  assert.deepEqual(retainLogWindow(previous, chunk("", 0, 0, { reset: true }), true), []);
});
test("pending incomplete characters or quiet EOF do not clear or duplicate visible text", () => {
  const previous = [chunk("你", 0, 3)];
  const quiet = chunk("", 3, 3, { size: 5, warning: "incomplete" });
  assert.deepEqual(retainLogWindow(previous, quiet, true), previous);
  assert.equal(retainLogWindow(previous, chunk("好", 3, 6), true).map(item => item.text).join(""), "你好");
});
test("follow stays sequential within its window and tails excessive growth", () => {
  assert.equal(nextLogFollowAction(null), "follow");
  assert.equal(logChunkRequest("/log", "follow", null, 0, "auto").tail, true);
  assert.equal(nextLogFollowAction(chunk("", 1, 1, { size: LOG_WINDOW_BYTES + 1 })), "follow");
  assert.equal(nextLogFollowAction(chunk("", 1, 1, { size: LOG_WINDOW_BYTES + 2 })), "end");
});
test("upward reading pauses follow while layout changes and explicit pause remain stable", () => {
  assert.equal(shouldPauseLogFollow(true, 300, 100, false), true);
  assert.equal(shouldPauseLogFollow(true, 300, 100, true), false);
  assert.equal(shouldPauseLogFollow(false, 300, 100, false), false);
  assert.equal(shouldPauseLogFollow(true, 100, 300, false), false);
});
test("oversized responses cannot grow the model beyond its cap", () => {
  assert.throws(() => retainLogWindow([], chunk("abcdef", 0, 6), false, 10), /缓冲区/);
});
