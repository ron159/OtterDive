import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["scheduleSessionSave", "persistRecovery", "reportPersistenceError", "clearPersistenceError", "renderPersistenceErrors"]);
const js = ts.transpileModule(ast.statements
  .filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup() {
  const elements = new Map();
  const input = id => {
    if (!elements.has(id)) elements.set(id, { textContent: "", title: "", hidden: true, classList: { toggle(_, hidden) { input(id).hidden = hidden; } } });
    return elements.get(id);
  };
  const doc = { id: 1, title: "draft.txt", dirty: true };
  let fail = true, callback;
  const context = vm.createContext({
    $: input, persistenceErrors: new Map(), state: { restoring: false, documents: [doc], workbench: { recoveryEnabled: true } },
    sessionTimer: 0, sessionSaveDelayMs: () => 1,
    window: { clearTimeout() {}, setTimeout(fn) { callback = fn; return 1; } },
    saveSession: async () => { if (fail) throw new Error("storage full"); },
    syncMarkdownModelFromEditor() {}, documentText: () => "unsaved text", recoveryKey: () => "draft:1", recoveryIds: new Map(),
    invoke: async () => { if (fail) throw new Error("disk full"); return { key: "draft:1", id: 12 }; }, log() {},
  });
  vm.runInContext(js, context);
  return { context, doc, input, succeed() { fail = false; }, async runTimer() { callback(); await new Promise(resolve => setImmediate(resolve)); } };
}

test("session storage failures stay visible until a later session write succeeds", async () => {
  const h = setup();
  h.context.scheduleSessionSave(); await h.runTimer();
  assert.match(h.context.persistenceErrors.get("session") ?? "", /storage full/);
  assert.equal(h.input("persistenceNotice").hidden, false);
  h.succeed(); h.context.scheduleSessionSave(); await h.runTimer();
  assert.equal(h.context.persistenceErrors.size, 0);
  assert.equal(h.input("persistenceNotice").hidden, true);
});

test("failed recovery can be retried without hiding an unrelated save error", async () => {
  const h = setup();
  await assert.rejects(h.context.persistRecovery(h.doc), /disk full/);
  assert.match(h.context.persistenceErrors.get("recovery:1") ?? "", /draft.txt.*disk full/);
  h.context.persistenceErrors.set("save:2", "other document is not saved");
  h.succeed(); await h.context.persistRecovery(h.doc);
  assert.equal(h.context.persistenceErrors.has("recovery:1"), false);
  assert.equal(h.context.persistenceErrors.get("save:2"), "other document is not saved");
  assert.equal(h.context.recoveryIds.get("draft:1"), 12);
});
