import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function sourceFile(path) {
  return ts.createSourceFile(path, fs.readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}

const main = sourceFile("../src/main.ts");
const settingsFunctions = main.statements.filter(node => ts.isFunctionDeclaration(node)
  && ["openSettingsPage", "closeSettingsPage"].includes(node.name?.text)).map(node => node.getText(main)).join("\n");
const settingsJs = ts.transpileModule(settingsFunctions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function element() {
  const classes = new Set(), attributes = new Map();
  return {
    inert: false, focused: false,
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
    },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name),
    focus() { this.focused = true; },
  };
}

function harness(withMarkdown = true) {
  const elements = new Map(["app", "workspace", "commandPalette", "settingsPage", "settingsButton", "settingsCloseButton"]
    .map(id => [id, element()]));
  elements.get("settingsPage").classList.add("hidden");
  const document = { markdown: "# Untouched content\n\nParagraph.", cursor: 12, history: ["previous edit"], popupVisible: true };
  let editorFocused = false, blurCount = 0;
  const bridge = { blur() { document.popupVisible = false; blurCount += 1; } };
  const context = {
    $: id => elements.get(id),
    markdownEditorCache: new Map(withMarkdown ? [[1, { bridge }]] : []),
    closeMenus() {}, renderSettingsMenu() {}, refreshSystemIntegrationStatus() {},
    focusActiveEditor() { editorFocused = true; },
  };
  vm.createContext(context);
  vm.runInContext(settingsJs, context);
  return { context, elements, document, get editorFocused() { return editorFocused; }, get blurCount() { return blurCount; } };
}

test("opening settings dismisses existing Markdown floating tools and isolates the workspace", () => {
  const h = harness();
  const content = structuredClone(h.document);
  h.context.openSettingsPage();
  assert.equal(h.elements.get("workspace").inert, true);
  assert.equal(h.elements.get("workspace").getAttribute("aria-hidden"), "true");
  assert.equal(h.document.popupVisible, false);
  assert.equal(h.blurCount, 1);
  assert.equal(h.elements.get("settingsCloseButton").focused, true);
  assert.equal(h.elements.get("settingsPage").classList.contains("hidden"), false);
  assert.deepEqual({ ...h.document, popupVisible: content.popupVisible }, content);
});

test("closing settings restores workspace interaction and editor focus without reopening old menus", () => {
  const h = harness();
  h.context.openSettingsPage();
  h.context.closeSettingsPage();
  assert.equal(h.elements.get("workspace").inert, false);
  assert.equal(h.elements.get("workspace").getAttribute("aria-hidden"), null);
  assert.equal(h.elements.get("settingsPage").classList.contains("hidden"), true);
  assert.equal(h.document.popupVisible, false);
  assert.equal(h.editorFocused, true);
});

test("source-editor settings restore focus and closing an already closed page leaves focus alone", () => {
  const h = harness(false);
  h.context.closeSettingsPage();
  assert.equal(h.editorFocused, false);
  h.context.openSettingsPage();
  h.context.closeSettingsPage();
  assert.equal(h.elements.get("workspace").inert, false);
  assert.equal(h.editorFocused, true);
});

test("the Markdown bridge blurs through Muya's public API while preserving selection and history", () => {
  const editor = sourceFile("../src/markdownEditor.ts");
  const bridge = editor.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "MarkdownEditorBridge");
  const blur = bridge.members.find(node => ts.isMethodDeclaration(node) && node.name?.getText(editor) === "blur");
  assert.ok(blur, "the bridge must expose Muya blur for settings lifecycle transitions");
  const js = ts.transpileModule(`globalThis.Bridge = class { ${blur.getText(editor)} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = {};
  vm.createContext(context);
  vm.runInContext(js, context);
  const instance = new context.Bridge();
  const selection = { anchor: 2, focus: 8 }, history = ["earlier edit"];
  let floating = true, focused = true;
  instance.muya = {
    blur(removeSelection = false) {
      assert.equal(removeSelection, false);
      floating = false;
      focused = false;
    },
    selection, history,
  };
  instance.blur();
  assert.equal(floating, false);
  assert.equal(focused, false);
  assert.equal(instance.muya.selection, selection);
  assert.equal(instance.muya.history, history);
});
