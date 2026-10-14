// Run against `npm run dev`. Supply PLAYWRIGHT_MODULE when Playwright is not installed locally.
// Uses a fresh browser/profile and mock native IPC, without reading the user's files or session.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const baseUrl = process.env.MONACO_QA_URL ?? "http://127.0.0.1:1420";
const artifactDirectory = process.env.MONACO_QA_ARTIFACT_DIR;
if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
let saved = JSON.stringify({
  version: 12, doubleClickDocumentType: "txt", themePreference: "light",
  markdownEditMode: "source", openFiles: [], draftDocuments: [],
});
const checks = [], errors = [], warnings = [], workers = [], failedRequests = [];
await context.exposeBinding("qaInvoke", async (_, command, args) => {
  if (command === "load_session") return saved;
  if (command === "save_session") { saved = args.snapshot; return null; }
  if (command === "startup_args") return { files: [], directories: [] };
  if (["list_snapshots", "take_open_requests"].includes(command)) return [];
  if (["shell_integration_status", "default_app_candidate_status", "set_shell_integration", "set_default_app_candidate"].includes(command)) {
    return { supported: true, enabled: false, detail: "QA fixture" };
  }
  if (command === "save_snapshot") return { id: 1, ...args.request };
  if (command === "plugin:app|version") return "0.0.0-qa";
  if (command === "plugin:window|inner_size") return { width: 1280, height: 900 };
  if (command === "plugin:window|scale_factor" || command === "plugin:event|listen") return 1;
  return null;
});
await context.addInitScript(() => {
  let callbackId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: (command, args) => window.qaInvoke(command, args),
    transformCallback: () => ++callbackId,
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
  if (message.type() === "warning") warnings.push(message.text());
});
page.on("worker", (worker) => workers.push(worker.url()));
page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));

let result;
try {
  await page.goto(baseUrl);
  await page.locator("[role=tab]").filter({ hasText: ".txt" }).waitFor();
  await page.evaluate(async () => {
    window.qaMonaco = await import("/node_modules/.vite/deps/monaco-editor_editor.js");
    window.qaEditor = qaMonaco.editor.getEditors().find((editor) => editor.getDomNode()?.closest("#editor"));
    if (!qaEditor) throw new Error("Main editor missing");
    qaEditor.focus();
  });
  const input = "alpha needle omega needle";
  await page.keyboard.type(input);
  assert.equal(await page.evaluate(() => qaEditor.getValue()), input);
  await page.evaluate(() => qaEditor.getModel().pushStackElement());
  await page.locator("#undoButton").click();
  // Monaco can group typed words separately; one undo must remove the final group.
  assert.notEqual(await page.evaluate(() => qaEditor.getValue()), input);
  await page.locator("#redoButton").click();
  assert.equal(await page.evaluate(() => qaEditor.getValue()), input);
  checks.push("Real main editor typing and toolbar undo/redo");

  await page.locator("#findButton").click();
  await page.locator("#currentFindInput").fill("needle");
  await page.waitForFunction(() => document.querySelector("#currentFindCount").textContent.includes("2"));
  await page.locator("#currentFindNextButton").click();
  await page.waitForFunction(() => qaEditor.getPosition().column === 20);
  assert.equal(await page.evaluate(() => {
    const start = qaEditor.getPosition().column - 1;
    return qaEditor.getValue().slice(start, start + 6);
  }), "needle");
  checks.push("Application find locates both matches and moves to the next match");
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    qaEditor.getModel().setValue("needle alpha\nneedle beta\noutside needle\n");
    qaEditor.setSelection(new qaMonaco.Selection(1, 1, 1, 7));
    qaEditor.focus();
  });
  await page.locator("#findButton").click();
  await page.locator("#currentFindInput").fill("needle");
  const waitForMatchTotal = (total) => page.waitForFunction((expected) => {
    const text = document.querySelector("#currentFindCount").textContent;
    return text === `${expected} 个结果` || text.endsWith(`/${expected}`);
  }, total);
  await waitForMatchTotal(3);
  const options = page.getByRole("group", { name: "搜索选项", exact: true });
  assert.equal(await options.getByRole("checkbox").count(), 8);
  assert.ok(await page.locator("#currentFindDock").evaluate((dock) => dock.getBoundingClientRect().height <= 44));
  for (const name of ["仅选区", "循环查找", "反向查找"]) {
    assert.equal(await options.getByRole("checkbox", { name, exact: true }).locator("..").locator("svg").count(), 1);
  }
  await options.getByRole("checkbox", { name: "仅选区", exact: true }).locator("..").click();
  await waitForMatchTotal(1);
  await page.locator("#currentFindInput").fill("");
  await options.getByRole("checkbox", { name: "搜索全部打开文件", exact: true }).locator("..").click();
  assert.equal(await options.getByRole("checkbox", { name: "仅选区", exact: true }).isDisabled(), true);
  assert.equal(await options.getByRole("checkbox", { name: "仅选区", exact: true }).locator("..").getAttribute("title"), "多文件搜索不使用当前选区");
  await options.getByRole("checkbox", { name: "搜索全部打开文件", exact: true }).locator("..").click();
  assert.equal(await options.getByRole("checkbox", { name: "仅选区", exact: true }).isDisabled(), false);
  await options.getByRole("checkbox", { name: "仅选区", exact: true }).locator("..").click();

  await page.evaluate(() => qaEditor.getModel().setValue("one\nneedle\noutside needle\n"));
  await page.locator("#currentFindInput").fill("one\\nneedle");
  await options.getByRole("checkbox", { name: "扩展模式", exact: true }).locator("..").click();
  await waitForMatchTotal(1);
  await options.getByRole("checkbox", { name: "正则表达式", exact: true }).locator("..").click();
  assert.equal(await options.getByRole("checkbox", { name: "扩展模式", exact: true }).isChecked(), false);
  await options.getByRole("checkbox", { name: "扩展模式", exact: true }).locator("..").click();
  assert.equal(await options.getByRole("checkbox", { name: "正则表达式", exact: true }).isChecked(), false);
  await options.getByRole("checkbox", { name: "扩展模式", exact: true }).locator("..").click();

  for (const [name, mirroredId] of [["循环查找", "wrapSearchInput"], ["反向查找", "reverseSearchInput"]]) {
    const input = options.getByRole("checkbox", { name, exact: true });
    const checked = await input.isChecked();
    const before = await input.locator("..").evaluate((label) => getComputedStyle(label).backgroundColor);
    await input.focus();
    await page.keyboard.press("Space");
    assert.equal(await input.isChecked(), !checked);
    assert.equal(await page.locator(`#${mirroredId}`).isChecked(), !checked);
    const after = await input.locator("..").evaluate((label) => getComputedStyle(label).backgroundColor);
    assert.notEqual(after, before, `${name} needs a visible selected state`);
    assert.equal(await input.locator("..").evaluate((label) => getComputedStyle(label).outlineStyle), "solid");
    await page.keyboard.press("Space");
  }
  checks.push("Compact search icons preserve selection scope, escaped search, exclusive modes, disabled scope and keyboard state");
  if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, "search-option-icons.png") });
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    const model = qaEditor.getModel();
    qaMonaco.editor.setModelLanguage(model, "json");
    model.setValue('{"value": }');
  });
  // The language contribution registers asynchronously after the model changes language.
  await page.waitForFunction(() => qaMonaco.editor.getModelMarkers({ resource: qaEditor.getModel().uri }).length > 0);
  const json = await page.evaluate(async () => {
    const api = await import("/node_modules/.vite/deps/monaco-editor_languages_features_json_register.js");
    const model = qaEditor.getModel();
    const worker = await (await api.getWorker())(model.uri);
    return worker.doValidation(model.uri.toString());
  });
  assert.ok(json.length > 0, "JSON worker must diagnose invalid JSON");
  checks.push(`JSON worker diagnostics (${json.length})`);

  await page.evaluate(() => {
    const model = qaEditor.getModel();
    qaMonaco.editor.setModelLanguage(model, "typescript");
    model.setValue('const count: number = "wrong";\nconst result = count.toFixed(2);');
  });
  const typescript = await page.evaluate(async () => {
    const api = await import("/node_modules/.vite/deps/monaco-editor_languages_features_typescript_register.js");
    const model = qaEditor.getModel();
    const worker = await (await api.getTypeScriptWorker())(model.uri);
    return {
      diagnostics: await worker.getSemanticDiagnostics(model.uri.toString()),
      info: await worker.getQuickInfoAtPosition(model.uri.toString(), 7),
    };
  });
  assert.ok(typescript.diagnostics.some((diagnostic) => diagnostic.code === 2322), "TypeScript assignment diagnostic");
  assert.ok(typescript.info, "TypeScript hover information");
  checks.push("TypeScript worker semantic diagnostics and quick info");

  for (const [language, source] of [["html", "<div><span>hello</span><p>world</p></div>"], ["css", "body{color:red;margin:0}"]]) {
    await page.evaluate(({ language, source }) => {
      const model = qaEditor.getModel();
      qaMonaco.editor.setModelLanguage(model, language);
      model.setValue(source);
      qaEditor.focus();
    }, { language, source });
    await page.locator("#formatDocumentButton").click();
    await page.waitForFunction((source) => qaEditor.getValue() !== source, source);
    assert.ok((await page.evaluate(() => qaEditor.getValue())).includes("\n"), `${language} formatted newlines`);
    checks.push(`Application ${language.toUpperCase()} formatting via language worker`);
  }

  // Keep this after the language workers: late feature registration broke services in new diff editors.
  await page.evaluate(async () => {
    const panels = await import("/src/workbenchPanels.ts");
    void panels.showComparison({
      title: "Monaco upgrade QA", original: "alpha\nbeta\ngamma\n",
      modified: "alpha\nchanged\ngamma\nadded\n", language: "plaintext", theme: "vs",
    });
  });
  const dialog = page.getByRole("dialog", { name: "Monaco upgrade QA" });
  await dialog.waitFor();
  await page.waitForFunction(() => qaMonaco.editor.getDiffEditors().some((editor) => editor.getLineChanges()?.length === 2));
  const diff = await page.evaluate(() => {
    const editor = qaMonaco.editor.getDiffEditors()[0];
    editor.goToDiff("next");
    return { changes: editor.getLineChanges(), modifiedLine: editor.getModifiedEditor().getPosition().lineNumber };
  });
  assert.equal(diff.changes.length, 2);
  assert.ok(diff.modifiedLine >= 2);
  if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, "monaco-comparison.png") });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForFunction(() => qaMonaco.editor.getDiffEditors().length === 0);
  checks.push("Production comparison dialog computes two hunks, navigates and disposes");

  for (const name of ["json", "ts", "html", "css", "editor"]) {
    assert.ok(workers.some((url) => url.includes(`${name}.worker`)), `Missing ${name} worker: ${workers}`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  result = { passed: true, checks, workers, warnings, errors, failedRequests };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, "monaco-failure.png") }).catch(() => {});
  result = { passed: false, error: error.stack ?? String(error), checks, workers, warnings, errors, failedRequests };
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  if (artifactDirectory) await writeFile(join(artifactDirectory, "monaco-results.json"), JSON.stringify(result, null, 2));
}
