// Isolated browser contexts and fixture-only native IPC; page evaluation is read-only.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const baseUrl = process.env.SETTINGS_QA_URL ?? "http://127.0.0.1:1421";
const phase = process.env.SETTINGS_QA_PHASE ?? "after";
const artifactDirectory = resolve(process.env.SETTINGS_QA_ARTIFACT_DIR ?? join(directory, "../../../../tasks/settings-consistency-2026-10-18"), phase);
const engines = (process.env.SETTINGS_QA_ENGINES ?? "chromium,webkit").split(",");
const platforms = (process.env.SETTINGS_QA_PLATFORMS ?? "macos,windows,linux").split(",");
const themes = (process.env.SETTINGS_QA_THEMES ?? "light,dark").split(",");
const viewports = (process.env.SETTINGS_QA_VIEWPORTS ?? "1440x900,1024x640,960x640,840x640").split(",").map(value => { const [width, height] = value.split("x").map(Number); return { width, height }; });
const userAgents = {
  macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
};
const results = [];
await mkdir(artifactDirectory, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await pause(70); }
  throw new Error(message);
}

async function createFixture(browser, platform, viewport, theme, result) {
  const context = await browser.newContext({ viewport, userAgent: userAgents[platform], colorScheme: theme, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  let saved = JSON.stringify({ version: 13, themePreference: theme, keymapProfile: "vscode", markdownEditMode: "source", workMode: "single", openFiles: ["/qa/settings.txt"], activePath: "/qa/settings.txt", draftDocuments: [], workbenchPreferences: { autoSaveMode: "off", recoveryEnabled: true, historyEnabled: false, spellcheckEnabled: false } });
  const integration = { shell: false, defaultApp: false };
  const snapshot = () => JSON.parse(saved);
  await context.exposeBinding("qaInvoke", async (_, command, args = {}) => {
    result.nativeCalls.push(command);
    if (command === "load_session") return saved;
    if (command === "save_session") { saved = args.snapshot; return null; }
    if (command === "startup_args") return { files: [], directories: [] };
    if (command === "open_path") return { title: "settings.txt", path: args.path, text: "Isolated settings QA fixture.\n", encoding: "UTF-8", lineEnding: "LF", fileSize: 30, readOnly: false, language: "plaintext", largeFile: false, diskRevision: "r1" };
    if (command === "file_revisions") return args.paths.map(path => ({ path, revision: "r1", error: null }));
    if (["list_snapshots", "take_open_requests", "migrate_markdown_assets", "template_list"].includes(command)) return [];
    if (["shell_integration_status", "set_shell_integration", "default_app_candidate_status", "set_default_app_candidate"].includes(command)) {
      const key = command.includes("shell") ? "shell" : "defaultApp";
      if (command.startsWith("set_")) integration[key] = args.enabled;
      return { supported: platform === "windows", enabled: integration[key], detail: platform === "windows" ? "隔离 QA 系统集成 fixture" : "此平台不提供 Windows 系统集成" };
    }
    if (command === "plugin:app|version") return "0.8.1-qa";
    if (command === "plugin:window|inner_size") return viewport;
    if (command === "plugin:window|scale_factor" || command === "plugin:event|listen") return 1;
    return null;
  });
  await context.addInitScript(() => {
    let callback = 0;
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, invoke: (command, args) => window.qaInvoke(command, args), transformCallback: () => ++callback, unregisterCallback: () => {}, convertFileSrc: path => path };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  return { context, snapshot, seedCustomPalette() {
    const current = snapshot();
    current.themeOverrides = { light: {}, dark: {}, ...current.themeOverrides, [theme]: theme === "dark" ? { background: "#151825", surface: "#222638", input: "#2D3148", editor: "#181C2B", text: "#F5F5FA", accent: "#C6AEFF" } : { background: "#F4F0E8", surface: "#FFFCF4", input: "#F4EFE3", editor: "#FFFDF8", text: "#25231F", accent: "#6942C2" } };
    saved = JSON.stringify(current);
  }, integration };
}

async function measurePanel(page) {
  await page.locator(".settings-sidebar-head strong").hover();
  await pause(100);
  return page.locator(".settings-panel.active").evaluate(panel => {
    const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
    const visible = element => getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden" && element.getClientRects().length > 0;
    const content = document.querySelector(".settings-content");
    const rows = [...panel.querySelectorAll(".settings-row")].filter(visible).map(row => {
      const icon = row.querySelector(":scope > .settings-row-icon");
      const copy = row.querySelector(":scope > .settings-row-copy");
      const title = copy?.querySelector(":scope > label") ?? copy?.querySelector("strong"), detail = copy?.querySelector(":scope > span");
      const titleStyle = title ? getComputedStyle(title) : null, detailStyle = detail ? getComputedStyle(detail) : null;
      return { label: copy?.querySelector("strong")?.textContent ?? "", dynamic: row.classList.contains("workbench-setting"), icon: Boolean(icon?.querySelector("svg")), copy: Boolean(copy), iconX: icon ? box(icon).x : null, copyX: copy ? box(copy).x : null, copyBounds: copy ? box(copy) : null, title: title ? { fontSize: titleStyle.fontSize, fontWeight: titleStyle.fontWeight, lineHeight: titleStyle.lineHeight, height: box(title).height } : null, detail: detail ? { lineHeight: detailStyle.lineHeight, height: box(detail).height } : null, bounds: box(row), columns: getComputedStyle(row).gridTemplateColumns, overflow: row.scrollWidth > row.clientWidth + 1 };
    });
    const fields = [...panel.querySelectorAll(".settings-row input:not([type='color']), .settings-row select, .font-select-trigger")].filter(visible).map(input => {
      let surface = input.closest(".settings-number-control") ?? input;
      const selectWrap = input.closest(".settings-select-control");
      if (selectWrap && parseFloat(getComputedStyle(selectWrap).borderTopWidth) > 0) surface = selectWrap;
      const style = getComputedStyle(surface), font = getComputedStyle(input);
      return { id: input.id, kind: input.tagName === "SELECT" ? "select" : input.tagName === "BUTTON" ? "font-select" : input.type === "number" ? "number" : "text", state: input.disabled ? "disabled" : input.classList.contains("custom-active") ? "custom-active" : "idle", value: input.value ?? input.textContent.trim(), disabled: input.disabled, bounds: box(surface), fontSize: font.fontSize, fontFamily: font.fontFamily, radius: style.borderRadius, borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle, borderColor: style.borderTopColor, wrappedNumber: input.type !== "number" || Boolean(input.closest(".settings-number-control")), unit: input.type === "number" ? input.closest(".settings-number-control")?.querySelector("span")?.textContent.trim() ?? "" : null };
    });
    return { section: panel.dataset.settingsPanel, content: { width: content.clientWidth, containerWidth: content.clientWidth - parseFloat(getComputedStyle(content).paddingLeft) - parseFloat(getComputedStyle(content).paddingRight), scrollWidth: content.scrollWidth, bounds: box(content) }, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, rows, fields };
  });
}

function checkMeasurements(result) {
  const fields = result.panels.flatMap(panel => panel.fields);
  for (const panel of result.panels) {
    if (panel.pageOverflow || panel.content.scrollWidth > panel.content.width + 1) result.failures.push(`${panel.section}: horizontal overflow`);
    const copyPositions = panel.rows.map(row => row.copyX).filter(value => value !== null);
    if (copyPositions.length && Math.max(...copyPositions) - Math.min(...copyPositions) > 1.5) result.failures.push(`${panel.section}: setting copy columns do not align`);
    for (const row of panel.rows) {
      if (!row.icon || !row.copy || !row.label) result.failures.push(`${panel.section}: missing icon/copy: ${row.label || "unnamed row"}`);
      if (row.overflow) result.failures.push(`${panel.section}: row overflow: ${row.label}`);
      if (row.title?.fontSize !== "13px" || row.title.fontWeight !== "600") result.failures.push(`${panel.section}: inconsistent title font: ${row.label}`);
    }
  }
  const singleLineRows = result.panels.flatMap(panel => panel.rows).filter(row => row.title && row.detail && row.title.height <= parseFloat(row.title.lineHeight) + 0.5 && row.detail.height <= parseFloat(row.detail.lineHeight) + 0.5);
  if (singleLineRows.some(row => row.dynamic) && singleLineRows.some(row => !row.dynamic)) {
    const heights = singleLineRows.map(row => row.copyBounds.height);
    if (Math.max(...heights) - Math.min(...heights) > 1) result.failures.push("Static/dynamic single-line setting copy heights differ");
  }
  for (const field of fields) {
    if (Math.abs(field.bounds.height - 36) > 1) result.failures.push(`${field.id}: expected 36px surface, got ${field.bounds.height}`);
    if (field.fontSize !== "12px") result.failures.push(`${field.id}: expected 12px font, got ${field.fontSize}`);
    if (field.kind === "number" && (!field.wrappedNumber || !field.unit)) result.failures.push(`${field.id}: missing unified number wrapper/unit`);
  }
  for (const kind of ["number", "select", "text", "font-select"]) for (const state of ["idle", "disabled", "custom-active"]) {
    const items = fields.filter(field => field.kind === kind && field.state === state);
    for (const property of ["radius", "borderWidth", "borderStyle", "borderColor"]) {
      const values = [...new Set(items.map(field => field[property]))];
      if (values.length > 1) result.failures.push(`${kind}/${state}: inconsistent ${property}: ${values.join(" | ")}`);
    }
  }
}

for (const engine of engines) {
  const browser = await playwright[engine].launch({ headless: true,
    ...(engine === "chromium" && process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
    ...(engine === "webkit" && process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
  try {
    for (const platform of platforms) for (const viewport of viewports) for (const theme of themes) {
      if (viewport.width < 1024 && (platform !== "macos" || theme !== "dark")) continue;
      const functional = viewport.width === 1440 && theme === "dark";
      const prefix = `${engine}-${platform}-${viewport.width}x${viewport.height}-${theme}`;
      const result = { engine, platform, viewport, theme, phase, passed: false, checks: [], panels: [], failures: [], errors: [], warnings: [], screenshots: [], nativeCalls: [] };
      const fixture = await createFixture(browser, platform, viewport, theme, result);
      const page = await fixture.context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", error => result.errors.push(error.stack ?? error.message));
      page.on("console", message => { if (message.type() === "error") result.errors.push(message.text()); if (message.type() === "warning") result.warnings.push(message.text()); });
      const shot = async name => { const file = `${prefix}-${name}.png`; await page.screenshot({ path: join(artifactDirectory, file) }); result.screenshots.push(file); };
      const section = async value => { await page.locator(`[data-settings-section="${value}"]`).click(); await page.locator(`[data-settings-panel="${value}"].active`).waitFor(); await page.locator(".settings-content").hover({ position: { x: 10, y: 10 } }); await page.mouse.wheel(0, -10000); await page.locator(".settings-sidebar-head strong").hover(); await pause(200); };
      const openSettings = async () => { await page.locator("#editor .view-lines").first().click(); await page.keyboard.press("Control+,"); await page.locator("#settingsPage").waitFor({ state: "visible" }); };
      const saved = (key, workbench = true) => workbench ? fixture.snapshot().workbenchPreferences?.[key] : fixture.snapshot()[key];
      try {
        await page.goto(baseUrl);
        await page.locator("#editor .monaco-editor").waitFor();
        await openSettings();
        const sections = await page.locator("[data-settings-section]:visible").evaluateAll(buttons => buttons.map(button => button.dataset.settingsSection));
        assert.equal(sections.includes("system"), platform === "windows");
        for (const value of sections) {
          await section(value);
          await shot(`${value}-top`);
          result.panels.push(await measurePanel(page));
          if (["appearance", "editor", "markdown"].includes(value)) {
            await page.locator(".settings-panel.active .settings-row").last().scrollIntoViewIfNeeded();
            await shot(`${value}-bottom`);
          }
        }
        result.checks.push(`All ${sections.length} visible setting categories measured and captured`);
        checkMeasurements(result);

        await section("editor");
        const numberFocus = page.locator("#settingsAutoSaveDelayInput");
        await numberFocus.hover();
        result.numberHover = await numberFocus.evaluate(input => { const style = getComputedStyle(input.closest(".settings-number-control") ?? input); return { borderColor: style.borderColor, background: style.background, borderWidth: style.borderWidth }; });
        await numberFocus.click(); await numberFocus.press("Tab"); await page.keyboard.press("Shift+Tab");
        result.numberFocus = await numberFocus.evaluate(input => { const style = getComputedStyle(input.closest(".settings-number-control") ?? input); return { focused: document.activeElement === input, focusVisible: input.matches(":focus-visible"), outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, boxShadow: style.boxShadow }; });
        assert.ok(result.numberFocus.focused && result.numberFocus.focusVisible, "Number keyboard focus missing");
        assert.ok(parseFloat(result.numberFocus.outlineWidth) > 0 || result.numberFocus.boxShadow !== "none", "Number focus indicator missing");
        await shot("number-keyboard-focus");
        await section("markdown");
        result.disabledSpellcheck = await page.locator("#workbench-spellcheckLanguage").evaluate(input => { const style = getComputedStyle(input); return { disabled: input.disabled, opacity: style.opacity, color: style.color, borderColor: style.borderColor, height: input.getBoundingClientRect().height }; });
        assert.equal(result.disabledSpellcheck.disabled, true);
        result.checks.push("Number hover and keyboard focus remain visible; spelling language is disabled in every theme/width");
        if (!functional) {
          assert.deepEqual(result.errors, []);
          result.passed = result.failures.length === 0;
          continue;
        }
        const persisted = [];
        for (const value of ["editor", "markdown"]) {
          await section(value);
          const ids = await page.locator('.settings-panel.active input[type="number"]').evaluateAll(inputs => inputs.map(input => input.id));
          for (const id of ids) {
            const input = page.locator(`#${id}`), initial = Number(await input.inputValue());
            const step = Number(await input.getAttribute("step") ?? 1), maximum = Number(await input.getAttribute("max") ?? Number.MAX_VALUE);
            const direction = initial + step <= maximum ? "ArrowUp" : "ArrowDown";
            const expected = Number((initial + (direction === "ArrowUp" ? step : -step)).toFixed(5));
            await input.click(); await input.press(direction); await input.press("Tab");
            const key = id === "settingsAutoSaveDelayInput" ? "autoSaveDelaySeconds" : id.replace("workbench-", "");
            await until(() => Math.abs(saved(key, id !== "settingsAutoSaveDelayInput") - expected) < 0.00001, `${id}: keyboard increment/decrement did not persist`);
            if (id === "settingsAutoSaveDelayInput") {
              await input.click(); await input.press(direction === "ArrowUp" ? "ArrowDown" : "ArrowUp"); await input.press("Tab");
              await until(() => Math.abs(saved(key, false) - initial) < 0.00001, "Auto-save delay reverse keyboard step did not persist");
              await input.click(); await input.press(direction); await input.press("Tab");
              await until(() => Math.abs(saved(key, false) - expected) < 0.00001, "Auto-save delay restored keyboard step did not persist");
            }
            persisted.push({ section: value, id, value: String(expected) });
          }
        }
        result.checks.push("Every number input changes through ArrowUp/ArrowDown and persists through native session IPC");

        await section("editor");
        const wordWrap = page.locator("#settingsWordWrapControl");
        const nextWrap = await wordWrap.getAttribute("aria-checked") !== "true";
        await wordWrap.click(); await until(() => saved("wordWrap", false) === nextWrap, "Static switch did not persist");
        await page.locator('#settingsWhitespaceControl [data-value="all"]').click();
        await until(() => saved("renderWhitespace", false) === "all", "Whitespace segmented setting did not persist");
        await page.locator('#settingsMarkdownWidthControl [data-value="wide"]').click();
        await until(() => saved("markdownContentWidth", false) === "wide", "Markdown width segmented setting did not persist");
        await section("markdown");
        const spell = page.locator("#workbench-spellcheckLanguage");
        assert.equal(await spell.isDisabled(), true);
        await page.locator("#workbench-spellcheckEnabled").click();
        await until(() => saved("spellcheckEnabled") === true, "Spellcheck switch did not persist");
        assert.equal(await spell.isEnabled(), true);
        await spell.click(); await spell.press("ControlOrMeta+A"); await spell.pressSequentially("en-US"); await spell.press("Tab");
        await until(() => saved("spellcheckLanguage") === "en-US", "Spellcheck language did not persist");
        for (const [id, key, value] of [["workbench-imageDirectory", "imageDirectory", "qa-assets"], ["workbench-printHeader", "printHeader", "QA header"]]) {
          const input = page.locator(`#${id}`); await input.click(); await input.press("ControlOrMeta+A"); await input.pressSequentially(value); await input.press("Tab");
          await until(() => saved(key) === value, `${id}: text did not persist`);
          persisted.push({ section: "markdown", id, value });
        }
        const paper = page.locator("#workbench-paperSize");
        await paper.selectOption("Letter"); await paper.press("Tab");
        result.nativeSelect = { inputValue: await paper.inputValue(), savedValue: saved("paperSize") };
        await until(() => saved("paperSize") === "Letter", "Native select choice did not persist");
        persisted.push({ section: "markdown", id: "workbench-paperSize", value: "Letter" });
        await page.locator("#workbench-spellcheckEnabled").click();
        await until(() => saved("spellcheckEnabled") === false, "Spellcheck off did not persist");
        assert.equal(await spell.isDisabled(), true);
        await shot("markdown-spellcheck-disabled");
        if (platform === "windows") {
          await section("system");
          const expectedShell = !fixture.integration.shell, expectedDefault = !fixture.integration.defaultApp;
          await page.locator("#settingsShellIntegrationButton").click();
          await until(() => fixture.integration.shell === expectedShell && saved("contextMenuEnabled", false) === expectedShell, "Windows integration switch did not reach native fixture/session");
          await page.locator("#settingsDefaultAppButton").click();
          await until(() => fixture.integration.defaultApp === expectedDefault && saved("defaultAppCandidateEnabled", false) === expectedDefault, "Windows default app switch did not reach native fixture/session");
        }
        result.checks.push("Static/dynamic switches, segmented choices, text, native select and disabled spelling language remain operable");

        await section("appearance");
        for (const [target, value] of [["Shell", "Arial, sans-serif"], ["Editor", "Courier New, monospace"]]) {
          await page.locator(`#settings${target}FontModeButton`).click();
          await page.locator(`#settings${target}FontModeMenu [data-value="custom"]`).click();
          const input = page.locator(`#settings${target}FontCustom`);
          await input.click(); await input.press("ControlOrMeta+A"); await input.pressSequentially(value); await input.press("Tab");
          await until(() => saved(`${target.toLowerCase()}FontCustom`, false) === value, `${target}: custom font text did not persist`);
          persisted.push({ section: "appearance", id: `settings${target}FontCustom`, value });
        }
        result.panels.push({ ...await measurePanel(page), section: "appearance-custom-fonts" });
        await shot("appearance-custom-font-fields");
        checkMeasurements(result);
        result.checks.push("Font dropdown custom mode and text inputs share the settings field design and save through normal UI actions");

        await page.reload(); await page.locator("#editor .monaco-editor").waitFor(); await openSettings();
        for (const value of ["appearance", "editor", "markdown"]) {
          await section(value);
          for (const field of persisted.filter(field => field.section === value)) assert.equal(await page.locator(`#${field.id}`).inputValue(), field.value, `${field.id}: reload lost saved value`);
        }
        assert.equal(await page.locator("#workbench-spellcheckLanguage").isDisabled(), true);
        await section("editor");
        assert.equal(await wordWrap.getAttribute("aria-checked"), String(nextWrap));
        assert.equal(await page.locator('#settingsWhitespaceControl [data-value="all"]').getAttribute("aria-pressed"), "true");
        result.checks.push("Saved numbers/text/select/switch/segmented values survive a new page load");

        const focusEvidence = async name => {
          await section("markdown"); const input = page.locator("#workbench-imageDirectory");
          await input.click(); await input.press("Tab"); await page.keyboard.press("Shift+Tab");
          const evidence = await input.evaluate(element => { const style = getComputedStyle(element); return { focused: document.activeElement === element, focusVisible: element.matches(":focus-visible"), outline: style.outline, outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, borderColor: style.borderColor, boxShadow: style.boxShadow }; });
          assert.ok(evidence.focused && evidence.focusVisible, `${name}: keyboard focus missing`);
          assert.ok((parseFloat(evidence.outlineWidth) > 0 && evidence.outlineStyle !== "none") || evidence.boxShadow !== "none", `${name}: focus indicator missing`);
          result[name] = evidence; await shot(name);
        };
        await page.locator("#workbench-highContrast").click();
        await until(() => saved("highContrast") === true, "High contrast did not persist");
        await focusEvidence("high-contrast-focus");
        await section("editor"); await page.locator("#workbench-highContrast").click(); await until(() => saved("highContrast") === false, "High contrast off did not persist");
        fixture.seedCustomPalette(); await page.reload(); await page.locator("#editor .monaco-editor").waitFor(); await openSettings();
        await focusEvidence("custom-palette-focus");
        result.checks.push("Keyboard focus remains visible under high contrast and a custom palette restored from fixture session data");
        assert.deepEqual(result.errors, []);
        result.passed = result.failures.length === 0;
      } catch (error) {
        result.failures.push(error.stack ?? String(error));
        await shot("failure").catch(() => {});
      } finally {
        result.nativeCalls = [...new Set(result.nativeCalls)];
        results.push(result);
        await writeFile(join(artifactDirectory, `${prefix}.json`), JSON.stringify(result, null, 2));
        await writeFile(join(artifactDirectory, "results.json"), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ case: prefix, passed: result.passed, failures: result.failures, errors: result.errors, checks: result.checks }, null, 2));
        await fixture.context.close();
      }
    }
  } finally { await browser.close(); }
}
if (phase === "after" && results.some(result => !result.passed)) process.exitCode = 1;
