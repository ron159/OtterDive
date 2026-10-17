// Supplement the wide-screen workflow evidence without rerunning or replacing it.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const baseUrl = process.env.MARKDOWN_QA_URL ?? "http://127.0.0.1:1421";
const directory = process.env.MARKDOWN_QA_ARTIFACT_DIR ?? "../../../tasks/markdown-workflows-2026-10-18";
await mkdir(directory, { recursive: true });
let wideResults;
try { wideResults = JSON.parse(await readFile(join(directory, "results.json"), "utf8")); }
catch { wideResults = []; }
const narrowResults = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, message) {
  for (let count = 0; count < 150; count++) { if (await check()) return; await pause(80); }
  throw new Error(message);
}

for (const engine of (process.env.MARKDOWN_QA_ENGINES ?? "chromium,webkit").split(",")) {
  const browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" && process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
    ...(engine === "webkit" && process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1024, height: 640 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const notes = "# 最小窗口阅读\n\n[跳转目标](target.md#target-section)\n\n" + Array.from({ length: 18 }, (_, index) =>
    `## 第 ${index + 1} 章\n\n` + `长文阅读与窄屏导航验证，第 ${index + 1} 章正文。Readable paragraphs should fit the available document width.\n\n`.repeat(10)).join("");
  const files = new Map([["/qa/notes.md", notes], ["/qa/target.md", "# Target document\n\n## Target section\n\nNarrow viewport navigation target.\n\n" + "Target paragraph.\n\n".repeat(35)]]);
  const dto = path => ({ path, title: path.split("/").at(-1), text: files.get(path), encoding: "UTF-8", lineEnding: "LF", fileSize: files.get(path).length,
    readOnly: false, language: "markdown", largeFile: false, diskRevision: "qa-r1" });
  let saved = JSON.stringify({ version: 13, themePreference: "light", markdownEditMode: "reading", workMode: "single", showDirectory: false,
    openFiles: [...files.keys()], activePath: "/qa/notes.md", draftDocuments: [], outlineDisplayMode: "always",
    workbenchPreferences: { autoSaveMode: "off", historyEnabled: false, recoveryEnabled: false } });
  let custom = [];
  const checks = [], errors = [], warnings = [];
  await context.exposeBinding("qaInvoke", async (_, command, args = {}) => {
    if (command === "load_session") return saved;
    if (command === "save_session") { saved = args.snapshot; return null; }
    if (command === "open_path") return dto(args.path);
    if (command === "startup_args") return { files: [], directories: [] };
    if (["list_snapshots", "take_open_requests"].includes(command)) return [];
    if (command === "file_revisions") return args.paths.map(path => ({ path, revision: "qa-r1", error: null }));
    if (command === "template_list") return custom;
    if (command === "template_save") {
      const item = { ...args.request, id: args.request.id ?? "user-narrow-1", updatedAt: Date.now() };
      custom = [item, ...custom.filter(previous => previous.id !== item.id)];
      return item;
    }
    if (command === "template_delete") { custom = custom.filter(item => item.id !== args.id); return null; }
    if (["shell_integration_status", "default_app_candidate_status"].includes(command)) return { supported: false, enabled: false, detail: "Narrow QA" };
    if (command === "plugin:app|version") return "0.0.0-qa";
    if (command === "plugin:window|inner_size") return { width: 1024, height: 640 };
    if (command === "plugin:window|scale_factor" || command === "plugin:event|listen") return 1;
    return null;
  });
  await context.addInitScript(() => {
    let callbackId = 0;
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: (command, args) => window.qaInvoke(command, args), transformCallback: () => ++callbackId,
      unregisterCallback: () => {}, convertFileSrc: path => path };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); if (message.type() === "warning") warnings.push(message.text()); });
  const screenshot = name => page.screenshot({ path: join(directory, `${engine}-narrow-${name}.png`) });
  const noHorizontalOverflow = async () => {
    const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(overflow.document <= overflow.viewport + 1 && overflow.body <= overflow.viewport + 1, JSON.stringify(overflow));
  };
  const withinViewport = async locator => {
    assert.equal(await locator.isVisible(), true);
    const bounds = await locator.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1025 && bounds.y + bounds.height <= 641, JSON.stringify(bounds));
  };
  const command = async id => {
    await page.locator("#commandButton").click();
    await page.locator("#commandInput").fill(id);
    await page.locator("#commandList .command-row").first().click();
  };
  let result;
  try {
    await page.goto(baseUrl);
    await page.locator("#markdownPreview h1").filter({ hasText: "最小窗口阅读" }).waitFor();
    await page.locator("#markdownPreview").hover();
    await page.mouse.wheel(0, 1800);
    await until(async () => (await page.locator("#markdownPreview").evaluate(element => element.scrollTop)) > 800, "Long reading document did not scroll");
    for (const id of ["markdownBackButton", "markdownForwardButton", "markdownSourceButton", "markdownReadingButton"]) await withinViewport(page.locator(`#${id}`));
    await noHorizontalOverflow();
    await screenshot("reading");
    checks.push("1024×640 long-form reading scrolls, mode/navigation controls stay in view and the page has no horizontal overflow");
    const chapterFour = page.locator("#outlineList").getByRole("button", { name: "第 4 章", exact: true });
    await chapterFour.click();
    await until(async () => (await chapterFour.getAttribute("aria-current")) === "location", "Clicked reading outline chapter did not become current");
    const chapterBounds = await page.locator("#markdownPreview").evaluate(element => {
      const chapter = [...element.querySelectorAll("h2")].find(heading => heading.textContent.trim() === "第 4 章");
      const header = element.querySelector(".markdown-preview-head");
      return { top: chapter?.getBoundingClientRect().top, headerBottom: header?.getBoundingClientRect().bottom };
    });
    assert.ok(chapterBounds.top >= chapterBounds.headerBottom - 1 && chapterBounds.top <= chapterBounds.headerBottom + 48,
      `Clicked chapter heading must remain visible below the sticky preview header: ${JSON.stringify(chapterBounds)}`);
    const clickedScroll = await page.locator("#markdownPreview").evaluate(element => element.scrollTop);
    await screenshot("reading-outline-click");
    checks.push("Clicking chapter four in the reading outline scrolls the actual preview and highlights the clicked chapter");
    await page.locator("#markdownPreview").hover();
    await page.mouse.wheel(0, 1500);
    await until(async () => (await page.locator("#markdownPreview").evaluate(element => element.scrollTop)) > clickedScroll + 800, "Manual reading scroll did not leave the clicked chapter");
    await until(() => page.locator("#markdownPreview").evaluate(element => {
      const offset = Math.max(32, element.querySelector(".markdown-preview-head").offsetHeight + 8);
      const top = element.getBoundingClientRect().top + offset + 1;
      let index = 0;
      element.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, candidate) => { if (heading.getBoundingClientRect().top <= top) index = candidate; });
      const current = document.querySelector('#outlineList .outline-row[aria-current="location"]');
      return index !== 4 && Number(current?.getAttribute("data-outline-index")) === index;
    }), "Reading outline did not follow the current preview chapter after a manual wheel scroll");
    await screenshot("reading");
    checks.push("Manual wheel scrolling clears the clicked outline position and follows the current preview heading");
    await page.locator('#markdownPreview a[href="target.md#target-section"]').click();
    await page.locator("#markdownPreview h2").filter({ hasText: "Target section" }).waitFor();
    await page.locator("#markdownBackButton").click();
    await page.locator("#markdownPreview h1").filter({ hasText: "最小窗口阅读" }).waitFor();
    await page.locator("#markdownForwardButton").click();
    await page.locator("#markdownPreview h2").filter({ hasText: "Target section" }).waitFor();
    await noHorizontalOverflow();
    checks.push("Narrow toolbar back and forward remain operable after a real Markdown link jump");

    await command("markdown.manageTemplates");
    const manager = page.getByRole("dialog", { name: "管理模板与片段", exact: true });
    await manager.getByRole("button", { name: "复制并编辑", exact: true }).click();
    const create = page.getByRole("dialog", { name: "保存自定义模板", exact: true });
    await create.getByLabel("模板名称", { exact: true }).fill("窄屏模板");
    await create.getByLabel("Markdown 内容", { exact: true }).fill("# {{title}}\n\n{{date}}\n\n" + "very-long-literal-line-".repeat(20));
    await create.getByRole("button", { name: "保存模板", exact: true }).click();
    await until(() => custom.length === 1, "Narrow template create did not persist");
    await manager.getByRole("button", { name: "编辑模板", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑模板", exact: true });
    await edit.getByLabel("模板名称", { exact: true }).fill("窄屏模板（已编辑）");
    await edit.getByRole("button", { name: "保存模板", exact: true }).click();
    await until(() => custom[0].title === "窄屏模板（已编辑）", "Narrow template update did not persist");
    await withinViewport(manager.getByRole("button", { name: "关闭", exact: true }));
    await noHorizontalOverflow();
    const dialogWidth = await manager.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(dialogWidth.scroll <= dialogWidth.width + 1, JSON.stringify(dialogWidth));
    await screenshot("templates");
    await page.keyboard.press("Tab");
    assert.equal(await manager.evaluate(element => element.contains(document.activeElement)), true);
    await manager.getByRole("button", { name: "删除模板", exact: true }).click();
    await manager.getByRole("button", { name: "取消删除", exact: true }).click();
    assert.equal(custom.length, 1);
    await manager.getByRole("button", { name: "删除模板", exact: true }).click();
    await manager.getByRole("button", { name: "确认删除", exact: true }).click();
    await until(() => custom.length === 0, "Narrow template delete did not persist");
    await manager.getByRole("button", { name: "关闭", exact: true }).click();
    await manager.waitFor({ state: "detached" });
    checks.push("Narrow template dialog supports copy/create, edit, cancel/delete, keyboard focus and visible close action without horizontal overflow");
    await command("markdown.manageTemplates");
    await manager.waitFor();
    await page.keyboard.press("Escape");
    await manager.waitFor({ state: "detached" });
    await noHorizontalOverflow();
    checks.push("Template manager can reopen and close with Escape at the minimum window size");
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    result = { engine, viewport: { width: 1024, height: 640 }, passed: true, checks, errors, warnings };
  } catch (error) {
    await screenshot("failure").catch(() => {});
    result = { engine, viewport: { width: 1024, height: 640 }, passed: false, error: error.stack ?? String(error), checks, errors, warnings };
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify(result, null, 2));
    narrowResults.push(result);
    const previous = wideResults.find(item => item.engine === engine);
    if (previous) previous.narrow = result;
    else wideResults.push({ engine, narrow: result });
    await writeFile(join(directory, "results.json"), JSON.stringify(wideResults, null, 2));
    await writeFile(join(directory, "narrow-results.json"), JSON.stringify(narrowResults, null, 2));
    await context.close();
    await browser.close();
  }
}
