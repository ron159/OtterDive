import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the production handlers with controlled time and editor boundaries.
const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "handleCurrentFindInput", "cancelScheduledCurrentFind", "scheduleCurrentFind",
  "findSelectedDocuments", "findCurrent", "findNextResult", "findPreviousResult",
  "setCurrentFindDockOpen",
]);
const handlers = ts.transpileModule(
  ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    .map(node => node.getText(ast)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function setup() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const calls = { searches: [], jumps: [], reveals: [], resets: 0 };
  const input = { value: "", focus() { context.document.activeElement = input; } };
  let hidden = false;
  const dock = { classList: {
    contains: () => hidden,
    toggle: (_, value) => { hidden = value; },
  } };
  const context = vm.createContext({
    currentFindTimer: 0,
    window: {
      clearTimeout: id => timers.delete(id),
      setTimeout: (callback, delay) => {
        timers.set(++timerId, { callback, at: now + delay });
        return timerId;
      },
    },
    document: { activeElement: input, body: { classList: { toggle() {} } } },
    $: id => id === "currentFindDock" ? dock : input,
    isInputMethodComposing: event => Boolean(event.isComposing),
    syncCurrentFindControls() {},
    resetSearchResults() { calls.resets++; },
    searchAllOpenFilesEnabled: () => false,
    currentSearchPatternError: () => "",
    setCurrentFindError() {},
    commitSearchHistory() {},
    activeDocument: () => ({ title: "sample.txt", encoding: "UTF-8" }),
    isMarkdownWysiwygActive: () => false,
    modelMatches() {
      calls.searches.push(input.value);
      return [{ line: 105, column: 3 }];
    },
    initialSearchResultIndex: () => 0,
    setSearchResults() {},
    openSearchResult(index) {
      calls.jumps.push(index);
      // Reproduce focus stolen after the synchronous input.focus() restoration.
      return Promise.resolve().then(() => { context.document.activeElement = "editor"; });
    },
    editor: { revealPositionInCenter: position => calls.reveals.push({ ...position }) },
    state: { results: null },
    rerunSearchForNavigation() { calls.jumps.push("explicit"); },
    markdownEditor: null,
    log() {},
  });
  vm.runInContext(handlers, context);
  function tick(ms) {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  }
  function type(value, isComposing = false) {
    input.value = value;
    context.handleCurrentFindInput({ isComposing });
  }
  return { context, input, calls, tick, type };
}

test("English typing waits for a pause, reveals the result and retains input focus", async () => {
  const h = setup();
  for (const value of ["h", "he", "hel", "hell", "hello"]) {
    h.type(value);
    h.tick(150);
    assert.deepEqual(h.calls.searches, []);
  }
  h.tick(250);
  await Promise.resolve();
  assert.deepEqual(h.calls.searches, ["hello"]);
  assert.deepEqual(h.calls.jumps, []);
  assert.deepEqual(h.calls.reveals, [{ lineNumber: 105, column: 3 }]);
  assert.equal(h.context.document.activeElement, h.input);
  h.type("hello world");
  h.tick(400);
  assert.deepEqual(h.calls.searches, ["hello", "hello world"]);
});

test("IME composition cancels pending search and waits after committing Chinese text", () => {
  const h = setup();
  h.type("z");
  h.context.cancelScheduledCurrentFind();
  h.type("zhong", true);
  h.tick(1000);
  assert.deepEqual(h.calls.searches, []);
  h.input.value = "中文";
  h.context.scheduleCurrentFind();
  h.type("中文");
  h.tick(399);
  assert.deepEqual(h.calls.searches, []);
  h.tick(1);
  assert.deepEqual(h.calls.searches, ["中文"]);
});

test("explicit navigation cancels pending live search", async () => {
  for (const command of ["findNextResult", "findPreviousResult"]) {
    const h = setup();
    h.type("hello");
    await h.context[command]();
    h.tick(1000);
    assert.deepEqual(h.calls.jumps, ["explicit"]);
    assert.deepEqual(h.calls.searches, []);
  }
});

test("closing the dock cancels pending search even when reopened immediately", () => {
  const h = setup();
  h.type("hello");
  h.context.setCurrentFindDockOpen(false);
  h.context.setCurrentFindDockOpen(true);
  h.tick(1000);
  assert.deepEqual(h.calls.searches, []);
});

test("clearing the query removes results without navigation", () => {
  const h = setup();
  h.type("hello");
  h.type("");
  h.tick(400);
  assert.equal(h.calls.resets, 1);
  assert.deepEqual(h.calls.jumps, []);
});

test("explicit find-all still navigates and cancels the pending live search", () => {
  const h = setup();
  h.type("hello");
  h.context.findSelectedDocuments(true);
  h.tick(1000);
  assert.deepEqual(h.calls.jumps, [0]);
  assert.deepEqual(h.calls.searches, ["hello"]);
});
