// Run against npm run dev. Set PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE if needed.
// MENU_QA_ENGINE supports chromium or webkit; checks the Windows/Linux web titlebar.
// Uses a fresh browser/profile and mock native IPC, without reading the user's files or session.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const engines = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const appWindow = JSON.parse(await readFile(new URL("../../tauri.conf.json", import.meta.url), "utf8")).app.windows[0];
const baseUrl = process.env.MENU_QA_URL ?? "http://127.0.0.1:1420";
const artifactDirectory = process.env.MENU_QA_ARTIFACT_DIR;
if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true });
const browser = await engines[process.env.MENU_QA_ENGINE ?? "chromium"].launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
let saved = JSON.stringify({
  recentFiles: ["/qa/very-long-file-name-with-descenders-gyp-example.md"],
  version: 12, doubleClickDocumentType: "txt", themePreference: "light",
  markdownEditMode: "source", openFiles: [], draftDocuments: [],
});
const checks = [], errors = [], warnings = [], failedRequests = [], invocations = [];
await context.exposeBinding("qaInvoke", async (_, command, args) => {
  invocations.push(command);
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
  Object.defineProperty(navigator, "platform", { value: "Win32" });
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36" });
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
page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));

try {
  await page.goto(baseUrl);
  await page.locator("[data-workbench-command]").first().waitFor({ state: "attached" });
  const plainMenuText = await page.locator(".menu-row").evaluateAll(rows => rows.filter(row =>
    [...row.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
  ).map(row => row.textContent));
  assert.deepEqual(plainMenuText, [], "Menu text must not occupy the icon column as an anonymous grid item");

  for (const [width, height] of [[1440, 900], [1280, 720], [appWindow.minWidth, appWindow.minHeight]]) {
    await page.setViewportSize({ width, height });
    for (const id of ["fileMenu", "editMenu", "searchMenu", "viewMenu"]) {
      const trigger = page.locator(`#${id}Button`);
      await trigger.click();
      const result = await page.locator(`#${id}`).evaluate(root => ({
        id: root.id, height: root.getBoundingClientRect().height,
        bottom: root.getBoundingClientRect().bottom,
        rows: [...root.querySelectorAll(".menu-row")].filter(row => row.offsetHeight).map(row => {
          const label = row.querySelector("strong");
          if (!label) return { title: row.textContent, labelMissing: true };
          const range = document.createRange(); range.selectNodeContents(label);
          return { title: label.textContent, height: row.getBoundingClientRect().height,
            textHeight: range.getBoundingClientRect().height,
            fontSize: parseFloat(getComputedStyle(label).fontSize),
            textWidth: range.getBoundingClientRect().width, labelWidth: label.getBoundingClientRect().width,
            command: row.dataset.workbenchCommand };
        }),
      }));
      assert.ok(result.height <= Math.min(height * .78, 760) + 1, `${id} must fit the window`);
      assert.ok(result.bottom <= height - 7, `${id} must not extend below the viewport`);
      for (const row of result.rows) {
        assert.ok(!row.labelMissing, `${row.title}: missing label`);
        assert.ok(row.textHeight <= row.fontSize * 1.6, `${row.title}: vertically wrapped menu text`);
        assert.ok(row.textWidth <= row.labelWidth + 1, `${row.title}: label overflows its column`);
        assert.ok(row.height <= 40, `${row.title}: stretched menu button`);
      }
      if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, `${width}-${id}.png`) });
      // The last row must remain reachable even when the menu needs scrolling.
      await page.keyboard.press("End");
      assert.equal(await page.locator(`#${id}`).evaluate(root => {
        const rows = [...root.querySelectorAll(".menu-row:not(:disabled)")].filter(row => row.offsetHeight);
        return document.activeElement === rows.at(-1);
      }), true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(id => document.activeElement?.id === `${id}Button`, id);
      checks.push({ viewport: { width, height }, ...result });
    }
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [trigger, menu] of [["languageButton", "languageMenu"], ["encodingButton", "encodingMenu"], ["lineEndingButton", "lineEndingMenu"]]) {
    await page.locator(`#${trigger}`).click();
    await page.locator(`#${menu}`).waitFor({ state: "visible" });
    const labels = await page.locator(`#${menu} .menu-row strong`).evaluateAll(nodes => nodes.map(label => {
      const range = document.createRange(); range.selectNodeContents(label);
      return { text: label.textContent, height: range.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(label).fontSize), title: label.closest("button").title };
    }));
    assert.ok(labels.length > 0);
    assert.ok(labels.every(label => label.height <= label.fontSize * 1.6), JSON.stringify({ menu, wrapped: labels.filter(label => label.height > label.fontSize * 1.6) }));
    if (menu === "languageMenu") assert.ok(labels.every(label => label.title === label.text), "Full language labels must remain available as tooltips");
    await page.keyboard.press("Escape");
    checks.push({ menu, labels: labels.length });
  }

  await page.locator("#fileMenuButton").click();
  await page.locator("#menuRecentButton").click();
  await page.locator("#recentMenu").waitFor({ state: "visible" });
  assert.equal(await page.locator("#recentList .menu-row strong").count(), 1);
  if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, "recent-files.png") });
  await page.keyboard.press("Escape");

  await page.locator('[role="tab"]').first().click({ button: "right" });
  await page.locator("#tabMenu").waitFor({ state: "visible" });
  assert.equal(await page.locator("#tabMenu .menu-row").evaluateAll(rows => rows.every(row => row.offsetHeight <= 40)), true);
  await page.keyboard.press("Escape");

  // Verify a generated row still dispatches its original action.
  await page.locator("#fileMenuButton").click();
  await page.locator('[data-workbench-command="file.recovery"]').click();
  const dialog = page.locator("dialog.workbench-dialog");
  await dialog.waitFor({ state: "visible" });
  assert.ok(invocations.includes("list_snapshots"));
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();

  await page.locator("#settingsButton").click();
  for (const section of ["appearance", "editor", "keybindings", "workspace", "system", "search", "about"]) {
    await page.locator(`[data-settings-section="${section}"]`).click();
    const label = await page.locator(`[data-settings-section="${section}"] strong`).evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      return { height: range.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(node).fontSize) };
    });
    assert.ok(label.height <= label.fontSize * 1.6);
    await page.locator(`[data-settings-panel="${section}"].active`).waitFor({ state: "visible" });
  }
  await page.locator("#settingsCloseButton").click();
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(failedRequests, []);
  const report = { passed: true, browser: await browser.version(), engine: process.env.MENU_QA_ENGINE ?? "chromium", checks, errors, warnings, failedRequests };
  if (artifactDirectory) await writeFile(join(artifactDirectory, "menus.json"), JSON.stringify(report, null, 2));
  console.log(`Menu browser regression passed: ${checks.length} layout cases, command dispatch, recent files, tab menu and 7 settings pages.`);
} catch (error) {
  if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, "failure.png") }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
