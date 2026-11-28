// Fresh browser profiles; fixture-only native IPC. Every editor action uses the UI.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOutlineFilter } from "./verify-outline-filter.mjs";
import { sectionFixture, verifyReadingSections } from "./verify-reading-sections.mjs";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const playwright = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const baseUrl = process.env.MARKDOWN_QA_URL ?? "http://127.0.0.1:1421";
const artifactDirectory = process.env.MARKDOWN_QA_ARTIFACT_DIR ?? "../../../tasks/markdown-workflows-2026-10-18";
await mkdir(artifactDirectory, { recursive: true });
const engines = (process.env.MARKDOWN_QA_ENGINES ?? "chromium,webkit").split(",");
const timeoutMs = Number(process.env.MARKDOWN_QA_TIMEOUT_MS ?? 15000);
const results = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, message, timeout = timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await pause(80); }
  throw new Error(message);
}

for (const engine of engines) {
  const notes = "# 阅读验证\n\n[前往目标章节](target.md#target-section)\n\n脚注入口[^note]。\n\n> ## 引用中的标题\n\n" + Array.from({ length: 22 }, (_, index) =>
    `## ${index === 3 || index === 6 ? "API 使用" : `第 ${index + 1} 章`}\n\n` + Array.from({ length: 9 }, (_, paragraph) => `这是第 ${index + 1} 章第 ${paragraph + 1} 段，用于检查阅读位置与模式切换。Local Markdown reading fixture.\n\n`).join("")).join("") + "\n[^note]: 验证脚注目标\n";
  const files = new Map([["/qa/notes.md", notes], ["/qa/target.md", sectionFixture + "\n## Repeated\n\nFirst bookmark section.\n\n" + "Bookmark context.\n\n".repeat(30) + "## Repeated\n\nEnd of document."]]);
  files.set("/qa/fresh.md", "# Fresh file\n");
  const revisions = new Map([...files.keys()].map(path => [path, "r1"]));
  const workspace = () => ({ root: "/qa", name: "QA workspace", items: [
    { path: "/qa/archive", name: "archive", depth: 0, isDir: true },
    ...[...files.keys()].sort().map(path => ({ path, name: path.split("/").at(-1), depth: path.includes("/archive/") ? 1 : 0, isDir: false })),
  ] });
  const dto = path => {
    if (!files.has(path)) throw new Error(`Missing fixture file: ${path}`);
    const text = files.get(path);
    return { title: path.split("/").at(-1), path, text, encoding: "UTF-8", lineEnding: "LF", fileSize: Buffer.byteLength(text),
      readOnly: false, language: "markdown", largeFile: false, diskRevision: revisions.get(path) ?? "r1" };
  };
  let saved = JSON.stringify({ version: 13, themePreference: "light", markdownEditMode: "reading", workMode: "workspace", showDirectory: true,
    workspaceRoot: "/qa", openFiles: ["/qa/notes.md", "/qa/target.md"], activePath: "/qa/notes.md", draftDocuments: [],
    bookmarks: { "file:/qa/target.md": [2] }, outlineDisplayMode: "always", workbenchPreferences: { autoSaveMode: "off", historyEnabled: false, recoveryEnabled: true, defaultReading: true } });
  let custom = [], templateNumber = 0, pendingMove;
  const calls = [], errors = [], warnings = [], checks = [];
  const invokeFixture = async (_, command, args = {}) => {
    calls.push({ command, args });
    if (command === "load_session") return saved;
    if (command === "save_session") { saved = args.snapshot; return null; }
    if (command === "startup_args") return { files: [], directories: [] };
    if (command === "read_workspace") return workspace();
    if (command === "open_path") return dto(args.path);
    if (command === "file_revisions") return args.paths.map(path => ({ path, revision: files.has(path) ? revisions.get(path) ?? "r1" : "missing", error: null }));
    if (["list_snapshots", "take_open_requests", "migrate_markdown_assets"].includes(command)) return [];
    if (command === "save_snapshot") return { id: 1, ...args.request };
    if (command === "template_list") return custom;
    if (command === "template_save") {
      const item = { ...args.request, id: args.request.id ?? `user-qa-${++templateNumber}`, updatedAt: Date.now() };
      custom = [item, ...custom.filter(previous => previous.id !== item.id)];
      return item;
    }
    if (command === "template_delete") { custom = custom.filter(item => item.id !== args.id); return null; }
    if (command === "pick_save_path" || command === "pick_pdf_save_path") return `/qa/${args.request.fileName}`;
    if (command === "save_document") {
      files.set(args.request.path, args.request.text);
      revisions.set(args.request.path, `r${Date.now()}`);
      return dto(args.request.path);
    }
    if (command === "preview_workspace_move") {
      pendingMove = args.request;
      return { token: "qa-move-token", ...args.request, referenceCount: 1, warnings: [],
        changedDocuments: [{ path: "/qa/notes.md", destinationPath: "/qa/notes.md", referenceCount: 1 }] };
    }
    if (command === "apply_workspace_move") {
      assert.equal(args.token, "qa-move-token");
      assert.deepEqual(args.request, pendingMove);
      const { path, destination } = args.request;
      const previousName = path.slice(4), nextName = destination.slice(4);
      files.set(destination, files.get(path)); files.delete(path);
      files.set("/qa/notes.md", files.get("/qa/notes.md").replaceAll(previousName, nextName));
      revisions.set("/qa/notes.md", `r${Date.now()}`);
      return { token: "qa-move-token", ...args.request, referenceCount: 1, warnings: [],
        changedDocuments: [{ path: "/qa/notes.md", destinationPath: "/qa/notes.md", referenceCount: 1 }] };
    }
    if (command === "delete_workspace_entry") { files.delete(args.request.path); return { path: args.request.path, workspace: workspace() }; }
    if (command === "export_markdown_bundle") return { path: args.request.outputPath, fileCount: 1, warnings: [] };
    if (["shell_integration_status", "default_app_candidate_status", "set_shell_integration", "set_default_app_candidate"].includes(command)) return { supported: true, enabled: false, detail: "QA fixture" };
    if (command === "plugin:app|version") return "0.0.0-qa";
    if (command === "plugin:window|inner_size") return { width: 1440, height: 950 };
    if (command === "plugin:window|scale_factor" || command === "plugin:event|listen") return 1;
    return null;
  };
  const installNativeBridge = () => {
    let callbackId = 0;
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: (command, args) => window.qaInvoke(command, args), transformCallback: () => ++callbackId,
      unregisterCallback: () => {}, convertFileSrc: path => path };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  };
  async function launchWindow() {
    const browser = await playwright[engine].launch({ headless: true,
      ...(engine === "chromium" && process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
      ...(engine === "webkit" && process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await context.exposeBinding("qaInvoke", invokeFixture);
    await context.addInitScript(installNativeBridge);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(90000);
    page.on("pageerror", error => errors.push(error.stack ?? error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); if (message.type() === "warning") warnings.push(message.text()); });
    return { browser, context, page };
  }
  let { browser, context, page } = await launchWindow();
  const command = async (_menu, id) => {
    await page.locator("#commandButton").click();
    await page.locator("#commandInput").fill(id);
    await page.locator("#commandList .command-row").first().click();
  };
  const activeTab = () => page.locator('#tabs [role="tab"][aria-selected="true"]');
  const shot = name => page.screenshot({ path: join(artifactDirectory, `${engine}-${name}.png`) });
  let result;
  try {
    await page.goto(baseUrl);
    await page.locator("#markdownPreview .markdown-preview-body h1").filter({ hasText: "阅读验证" }).waitFor();
    await until(async () => (await page.locator('#tabs [role="tab"]').count()) === 2, "Fixture tabs did not restore");
    await verifyOutlineFilter(page, notes, shot);
    checks.push("Filtered duplicate headings navigate to their original positions in reading, live, source and split views across document switches");
    let preview = page.locator("#markdownPreview");
    const isVisibleInPreview = selector => preview.evaluate((pane, selector) => {
      const element = pane.querySelector(selector);
      if (!element) return false;
      const target = element.getBoundingClientRect(), frame = pane.getBoundingClientRect();
      return target.top >= frame.top && target.bottom <= frame.bottom;
    }, selector);
    await page.getByRole("button", { name: "第 2 章", exact: true }).click();
    await until(() => isVisibleInPreview('h2[id="第-2-章"]'), "Outline selected the wrong heading after a blockquote");
    await page.getByRole("button", { name: "阅读验证", exact: true }).click();
    await preview.locator('a[href="#fn-1"]').click();
    await until(() => isVisibleInPreview('#fn-1'), "Footnote reference did not reveal its note");
    await preview.locator('a[href="#fnref-1"]').click();
    await until(() => isVisibleInPreview('#fnref-1'), "Footnote backlink did not return to its reference");
    checks.push("Outline navigation after quoted headings and both directions of a footnote link");
    await page.locator("#markdownPreview").hover();
    await page.mouse.wheel(0, 3100);
    await until(async () => (await page.locator("#markdownPreview").evaluate(element => element.scrollTop)) > 1000, "Reading pane did not scroll");
    await until(() => JSON.parse(saved).markdownLocations?.["file:/qa/notes.md"]?.scroll.fraction > 0.05, "Reading scroll was not persisted");
    const beforeReload = await page.locator("#markdownPreview").evaluate(element => element.scrollTop);
    await shot("reading-before-reload");
    await page.reload();
    await page.locator("#markdownPreview .markdown-preview-body h1").filter({ hasText: "阅读验证" }).waitFor();
    await until(async () => Math.abs((await page.locator("#markdownPreview").evaluate(element => element.scrollTop)) - beforeReload) < 80, "Reading position was not restored after reload");
    checks.push("Reading scroll persists through a fresh page load");
    await page.locator("#markdownSourceButton").click();
    await page.locator("#markdownReadingButton").click();
    await until(async () => Math.abs((await page.locator("#markdownPreview").evaluate(element => element.scrollTop)) - beforeReload) < 150, "Source/reading mode switch lost the chapter position");
    await shot("reading-restored");
    checks.push("Source and reading mode switch retains the current chapter");

    await verifyReadingSections({ page, command, until, shot, calls, saved: () => JSON.parse(saved) });
    checks.push("Reading folds, nested navigation, keyboard, persisted state and clean print/export");
    await page.locator('#markdownPreview a[href="target.md#target-section"]').click();
    await until(async () => (await activeTab().innerText()).includes("target.md"), "Markdown link did not open target document");
    await page.locator("#markdownPreview h2").filter({ hasText: "Target section" }).waitFor();
    await page.locator("#markdownSplitButton").click();
    await page.locator("#markdownBackButton").click();
    await until(async () => (await activeTab().innerText()).includes("notes.md"), "Back navigation did not return to notes");
    await page.locator('#markdownReadingButton[aria-pressed="true"]').waitFor();
    await page.locator("#markdownForwardButton").click();
    await until(async () => (await activeTab().innerText()).includes("target.md"), "Forward navigation did not return to target");
    await page.locator('#markdownSplitButton[aria-pressed="true"]').waitFor();
    checks.push("Real Markdown link and back/forward restore reading and split independently");

    await command("file", "file.newMarkdown");
    const richDraft = await activeTab().getAttribute("title");
    await page.locator('#markdownWysiwygButton[aria-pressed="true"]').waitFor();
    const richInput = page.locator('#markdownWysiwyg [contenteditable="true"]').first();
    await richInput.click();
    await page.keyboard.type("rich draf");
    // Switch before Muya's animation-frame batch has delivered the last keystroke.
    await page.locator("#markdownWysiwyg").evaluate(pane => {
      pane.addEventListener("input", () => queueMicrotask(() => {
        document.querySelector('#tabs [title="/qa/notes.md"] .tab-title').click();
      }), { once: true });
    });
    await page.keyboard.type("t");
    await page.locator('#markdownReadingButton[aria-pressed="true"]').waitFor();
    await page.locator('.tree-item[data-path="/qa/fresh.md"]').click();
    await until(async () => (await activeTab().getAttribute("title")) === "/qa/fresh.md", "Fresh file did not open");
    await page.locator('#markdownReadingButton[aria-pressed="true"]').waitFor();
    await page.locator(`#tabs [title="${richDraft}"] .tab-title`).click();
    const richText = page.locator("#markdownWysiwyg").getByText("rich draft", { exact: true }).first();
    await richText.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await until(() => page.evaluate(() => window.getSelection()?.focusOffset === 8), "Rich cursor was not placed at offset 8");
    await command("file", "file.newMarkdown");
    const sourceDraft = await activeTab().getAttribute("title");
    await page.locator("#markdownSourceButton").click();
    await page.locator("#editor .view-lines").click();
    await page.keyboard.type("source draft");
    await page.keyboard.press("Shift+ArrowLeft");
    const modes = [["/qa/notes.md", "reading"], [richDraft, "wysiwyg"], ["/qa/target.md", "split"], [sourceDraft, "source"]];
    async function verifyTab(title, mode) {
      await page.locator(`#tabs [role="tab"][title="${title}"] .tab-title`).click();
      await page.locator(`[data-markdown-mode="${mode}"][aria-pressed="true"]`).waitFor();
      if (mode === "reading" || mode === "split") await page.locator("#markdownPreview .markdown-body h1").waitFor();
      if (mode === "wysiwyg") await page.locator("#markdownWysiwyg").getByText("rich draft", { exact: true }).first().waitFor();
      if (mode === "source") await page.locator("#editor .view-lines").getByText("source draft", { exact: true }).waitFor();
    }
    for (let pass = 0; pass < 2; pass++) for (const [title, mode] of modes) await verifyTab(title, mode);
    await page.locator('#tabs [role="tab"][title="/qa/target.md"] .tab-close').click();
    await command("file", "file.reopenClosed");
    assert.equal(await activeTab().getAttribute("title"), "/qa/target.md");
    await page.locator('#markdownSplitButton[aria-pressed="true"]').waitFor();
    async function verifySavedDrafts(activeTitle) {
      await until(() => {
        const snapshot = JSON.parse(saved);
        return (snapshot.activePath ?? snapshot.draftDocuments.find(d => d.id === snapshot.activeDraftId)?.title) === activeTitle
          && snapshot.draftDocuments.length === 2;
      }, "Session did not capture both drafts and the active tab");
      const snapshot = JSON.parse(saved);
      assert.deepEqual(snapshot.draftDocuments.map(d => {
        const key = `draft:${d.id}`;
        const cursor = snapshot.markdownLocations[key]?.cursor;
        return [d.title, d.text.trimEnd(), d.dirty, snapshot.documentMarkdownModes[key], cursor?.anchor?.ch, cursor?.focus?.ch];
      }), [[richDraft, "rich draft", true, "wysiwyg", 8, 8], [sourceDraft, "source draft", true, "source", 12, 11]]);
    }
    await verifySavedDrafts("/qa/target.md");
    await browser.close();
    ({ browser, context, page } = await launchWindow());
    preview = page.locator("#markdownPreview");
    await page.goto(baseUrl);
    await page.locator('#markdownSplitButton[aria-pressed="true"]').waitFor();
    for (const [title, mode] of modes) await verifyTab(title, mode);
    await verifySavedDrafts(sourceDraft);
    await page.locator("#markdownReadingButton").click();
    await page.locator("#markdownPreview .markdown-body").waitFor();
    await page.locator("#markdownWysiwygButton").click();
    await page.locator("#markdownWysiwyg").getByText("source draft", { exact: true }).first().waitFor();
    await page.locator("#markdownSourceButton").click();
    await until(async () => (await page.locator("#statusRight").innerText()).includes("第 12 列"), "Source cursor was not restored");
    for (const title of [richDraft, sourceDraft]) {
      const draftTab = page.locator(`#tabs [role="tab"][title="${title}"]`);
      await draftTab.locator(".tab-dirty-dot").waitFor();
    }
    checks.push("Four mixed tabs survive repeated switching, closed-tab reopen and a browser process restart with dirty drafts and distinct cursors");

    await verifyTab("/qa/target.md", "split");
    await page.locator("#markdownReadingButton").click();
    await preview.locator("h2").filter({ hasText: /^Repeated$/ }).first().waitFor();
    const repeats = page.locator('#outlineList button[aria-label="Repeated"]');
    const ids = await preview.locator("h2").filter({ hasText: /^Repeated$/ }).evaluateAll(items => items.map(item => item.id));
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    const openBookmarks = () => preview.getByRole("button", { name: "标题书签", exact: true }).click();
    const bookmarks = page.getByRole("dialog", { name: "标题书签", exact: true });
    const bookmarkName = bookmarks.getByLabel("书签名称", { exact: true });
    for (const [index, name] of ["第一处", "第二处"].entries()) {
      await repeats.nth(index).click();
      await openBookmarks();
      assert.equal(await bookmarkName.inputValue(), "Repeated");
      await bookmarkName.fill(name);
      await bookmarks.getByRole("button", { name: "添加当前标题" }).click();
      await bookmarks.getByRole("button", { name: "关闭" }).click();
    }
    const savedMarks = path => JSON.parse(saved).readingBookmarks?.[`file:${path}`];
    await until(() => savedMarks("/qa/target.md")?.length === 2, "Duplicate heading bookmarks were not saved");
    assert.deepEqual(savedMarks("/qa/target.md").map(item => item.anchor), ids);
    await page.reload();
    await repeats.first().click();
    await openBookmarks();
    await bookmarks.getByRole("button", { name: "重命名 第二处" }).click();
    await bookmarkName.fill("返回末章");
    await bookmarks.getByRole("button", { name: "保存名称" }).click();
    await shot("heading-bookmarks");
    await bookmarks.getByRole("button", { name: /^返回末章 #/ }).click();
    await until(() => isVisibleInPreview(`h2[id="${ids[1]}"]`), "Bookmark did not jump to the last duplicate");
    await page.locator("#markdownBackButton").click();
    await until(() => isVisibleInPreview(`h2[id="${ids[0]}"]`), "Back did not restore the first duplicate");
    await openBookmarks();
    await bookmarks.getByRole("button", { name: "删除 第一处" }).click();
    await bookmarks.getByRole("button", { name: "关闭" }).click();
    await until(() => savedMarks("/qa/target.md")?.length === 1, "Bookmark removal did not persist");
    assert.deepEqual(savedMarks("/qa/target.md"), [{ anchor: ids[1], name: "返回末章" }]);
    assert.deepEqual(JSON.parse(saved).bookmarks["file:/qa/target.md"], [2]);
    checks.push("Named heading bookmarks distinguish duplicate anchors, survive reload, navigate and return, rename and delete alongside line bookmarks");

    await command("file", "markdown.manageTemplates");
    const manager = page.getByRole("dialog", { name: "管理模板与片段" });
    await manager.getByRole("button", { name: "会议记录 · 内置", exact: true }).click();
    await manager.getByRole("button", { name: "复制并编辑", exact: true }).click();
    const create = page.getByRole("dialog", { name: "保存自定义模板", exact: true });
    await create.getByLabel("模板名称", { exact: true }).fill("QA 模板");
    const raw = "# {{title}}\n\n{{date}} {{time}}\n\n保留 {{unknown}} 和 <script>literal</script>\n";
    await create.getByLabel("Markdown 内容", { exact: true }).fill(raw);
    await create.getByRole("button", { name: "保存模板", exact: true }).click();
    await until(() => custom.length === 1, "Custom template was not saved");
    assert.equal(custom[0].text, raw);
    await manager.getByRole("button", { name: "编辑模板", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑模板", exact: true });
    await edit.getByLabel("模板名称", { exact: true }).fill("QA 片段");
    await edit.getByRole("button", { name: "保存模板", exact: true }).click();
    await until(() => custom[0].title === "QA 片段", "Template edit was not saved");
    await manager.getByRole("button", { name: "编辑模板", exact: true }).click();
    await edit.getByLabel("模板名称", { exact: true }).fill("不应保存");
    await page.keyboard.press("Escape");
    await edit.waitFor({ state: "detached" });
    assert.equal(custom[0].title, "QA 片段");
    await until(() => manager.evaluate(element => element.contains(document.activeElement)), "Escape did not return keyboard focus to the template manager");
    await shot("template-manager");
    await manager.getByRole("button", { name: "关闭", exact: true }).click();
    checks.push("Built-in template copies, custom CRUD editing, literal content and Escape cancellation");

    await command("file", "file.newFromTemplate");
    const picker = page.getByRole("dialog", { name: "从模板新建", exact: true });
    await picker.getByRole("button", { name: "QA 片段", exact: true }).click();
    await picker.getByLabel("文档标题", { exact: true }).fill("QA Document");
    const expanded = await picker.getByLabel("使用后预览", { exact: true }).inputValue();
    assert.match(expanded, /^# QA Document\n\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.ok(expanded.includes("{{unknown}}"));
    await picker.getByRole("button", { name: "新建文档", exact: true }).click();
    await until(async () => (await activeTab().innerText()).includes("QA Document.md"), "Template did not create a Markdown tab");
    await page.locator("#markdownSourceButton").click();
    await page.locator("#saveButton").click();
    await until(() => files.get("/qa/QA Document.md") === expanded, "Created document did not retain the expanded template");
    await page.locator("#editor .view-lines").click();
    await page.keyboard.press("Meta+End");
    await command("edit", "markdown.insertTemplate");
    const insert = page.getByRole("dialog", { name: "插入模板片段", exact: true });
    await insert.getByRole("button", { name: "QA 片段", exact: true }).click();
    const inserted = await insert.getByLabel("使用后预览", { exact: true }).inputValue();
    await insert.getByRole("button", { name: "插入片段", exact: true }).click();
    await page.locator("#saveButton").click();
    await until(() => files.get("/qa/QA Document.md")?.includes(inserted + inserted) || files.get("/qa/QA Document.md") === expanded + inserted,
      "Template fragment was not inserted at the selected editor position");
    checks.push("Template variables, new Markdown document and insertion through the main editor");
    await command("file", "markdown.saveTemplate");
    const saveCurrent = page.getByRole("dialog", { name: "保存自定义模板", exact: true });
    await saveCurrent.getByLabel("模板名称", { exact: true }).fill("当前文档副本");
    await saveCurrent.getByRole("button", { name: "保存模板", exact: true }).click();
    await until(() => custom.length === 2, "Save current document as template did not persist");
    assert.equal(custom.find(item => item.title === "当前文档副本").text, files.get("/qa/QA Document.md"));
    await command("file", "markdown.manageTemplates");
    await manager.getByRole("button", { name: "QA 片段", exact: true }).click();
    await manager.getByRole("button", { name: "删除模板", exact: true }).click();
    await manager.getByRole("button", { name: "确认删除", exact: true }).click();
    await until(() => custom.length === 1 && custom[0].title === "当前文档副本", "Template delete did not preserve other templates");
    await manager.getByRole("button", { name: "关闭", exact: true }).click();
    checks.push("Save current document as template and delete one custom template");

    // The backend owns the filesystem/refactor behavior; this verifies the real UI command contract.
    await page.locator('.tree-item[data-path="/qa/target.md"]').click({ button: "right" });
    await page.locator("#treeRenameButton").click();
    await page.getByRole("textbox", { name: "重命名 target.md", exact: true }).fill("renamed.md");
    await page.keyboard.press("Enter");
    await page.locator("#confirmOkButton").click();
    await until(() => files.has("/qa/renamed.md"), "Inline rename did not invoke the refactor command");
    await page.locator('.tree-item[data-path="/qa/renamed.md"]').waitFor();
    await page.locator('.tree-item[data-path="/qa/renamed.md"]').click({ button: "right" });
    await page.locator("#treeMoveButton").click();
    await page.locator("#inputDialogInput").fill("archive/renamed.md");
    await page.locator("#inputOkButton").click();
    await page.locator("#confirmOkButton").click();
    await until(() => files.has("/qa/archive/renamed.md"), "Move did not invoke the refactor command");
    await until(() => savedMarks("/qa/archive/renamed.md")?.[0]?.anchor === ids[1], "Moved document lost its heading bookmark");
    assert.equal(savedMarks("/qa/target.md"), undefined);
    assert.equal(savedMarks("/qa/renamed.md"), undefined);
    checks.push("Tree inline rename and move invoke preview/confirmed apply with matching tokens");
    const movedPath = "/qa/archive/renamed.md";
    await page.locator(`.tree-item[data-path="${movedPath}"]`).click();
    await page.locator("#markdownReadingButton").click();
    await until(() => JSON.parse(saved).activePath === movedPath && JSON.parse(saved).documentMarkdownModes?.[`file:${movedPath}`] === "reading", "Moved tab was not saved");
    files.set(movedPath, "The bookmarked heading has been removed.");
    await page.reload();
    await preview.locator(".markdown-body").getByText("The bookmarked heading has been removed.").waitFor();
    await openBookmarks();
    assert.equal(await bookmarks.getByRole("button", { name: /^返回末章 #/ }).isDisabled(), true);
    assert.equal(await bookmarks.getByRole("button", { name: "添加当前标题" }).isDisabled(), true);
    await bookmarks.getByRole("button", { name: "删除 返回末章" }).click();
    await bookmarks.getByRole("button", { name: "关闭" }).click();
    await until(() => !savedMarks(movedPath), "Obsolete bookmark was not removed");
    checks.push("Missing headings stay identifiable after a move and restart and can be removed in a document with no headings");
    await page.locator('.tree-item[data-path="/qa/archive/renamed.md"]').click({ button: "right" });
    await page.locator("#treeDeleteButton").click();
    await page.locator("#confirmOkButton").click();
    await until(() => !files.has("/qa/archive/renamed.md"), "Tree delete did not invoke native trash command");
    await page.locator('.tree-item[data-path="/qa/notes.md"]').click();
    await command("file", "file.exportBundle");
    await until(() => calls.some(call => call.command === "export_markdown_bundle"), "Bundle command did not reach native I/O");
    const bundle = calls.findLast(call => call.command === "export_markdown_bundle").args.request;
    assert.equal(bundle.documentPath, "/qa/notes.md");
    assert.equal(bundle.workspaceRoot, "/qa");
    assert.equal(bundle.text, files.get("/qa/notes.md"));
    assert.equal(bundle.outputPath, "/qa/notes.zip");
    await shot("bundle-complete");
    checks.push("Tree trash action and Markdown+assets bundle request include current document and workspace");
    assert.deepEqual(errors, []);
    result = { engine, passed: true, checks, errors, warnings, nativeCalls: calls.map(call => call.command) };
  } catch (error) {
    await shot("failure").catch(() => {});
    result = { engine, passed: false, error: error.stack ?? String(error), checks, errors, warnings, nativeCalls: calls.map(call => call.command) };
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify(result, null, 2));
    results.push(result);
    await context.close();
    await browser.close();
    await writeFile(join(artifactDirectory, "results.json"), JSON.stringify(results, null, 2));
  }
}
