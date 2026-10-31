import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { mainFunctions } from "./support/mainFunctions.mjs";

function setup() {
  const doc = { id: 1, path: "/draft.txt", dirty: true };
  const timers = new Map(), saves = [];
  let timerId = 0;
  const context = vm.createContext({
    DEFAULT_AUTO_SAVE_DELAY_SECONDS: 5, MIN_AUTO_SAVE_DELAY_SECONDS: 1, MAX_AUTO_SAVE_DELAY_SECONDS: 3600,
    autoSaveTimers: new Map(), workspaceMoveInProgress: false,
    state: { documents: [doc], workbench: { autoSaveMode: "afterDelay" }, restoring: false, autoSaveDelaySeconds: 7 },
    window: {
      clearTimeout: id => timers.delete(id),
      setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    },
    saveDocument: async (...args) => saves.push(args), log() {},
  });
  vm.runInContext(mainFunctions(["normalizeAutoSaveDelaySeconds", "scheduleAutoSave", "cancelAutoSave"]), context);
  return { context, doc, timers, saves };
}

test("auto-save delay accepts settings values and clamps invalid boundaries", () => {
  const { context } = setup();
  for (const [input, expected] of [[undefined, 5], [Infinity, 5], [0, 1], [4000, 3600], [2.6, 3], ["12", 12]]) {
    assert.equal(context.normalizeAutoSaveDelaySeconds(input), expected);
  }
});

test("a later edit replaces the pending deadline and cancellation prevents a save", async () => {
  const { context, doc, timers, saves } = setup();
  context.scheduleAutoSave(doc);
  context.scheduleAutoSave(doc);
  assert.equal(timers.size, 1);
  const [id, pending] = [...timers][0];
  assert.equal(pending.delay, 7000);
  timers.delete(id);
  await pending.callback();
  assert.deepEqual(saves, [[doc, false, true]]);
  context.scheduleAutoSave(doc);
  context.cancelAutoSave(doc.id);
  assert.equal(timers.size, 0);
});

test("a pending auto-save cannot write a document that became protected or closed", async () => {
  for (const update of [doc => { doc.dirty = false; }, doc => { doc.readOnly = true; },
    doc => { doc.path = null; }, doc => { doc.externalRevision = "changed"; },
    (_, context) => { context.state.documents = []; }]) {
    const { context, doc, timers, saves } = setup();
    context.scheduleAutoSave(doc);
    const pending = [...timers.values()][0];
    update(doc, context);
    await pending.callback();
    assert.deepEqual(saves, []);
  }
});
