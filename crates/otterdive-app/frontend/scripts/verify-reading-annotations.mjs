// Run against the built frontend. Only native IPC is substituted, with a temporary workspace and browser profile.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await mkdtemp(join(tmpdir(), "otterdive-reading-"));
const workspace = join(root, "workspace"), profile = join(root, "profile");
await mkdir(workspace);
let path = join(workspace, "notes.md"), exportTo = join(workspace, "excerpts.md");
const duplicate = "a".repeat(54) + "needle" + "b".repeat(54);
const source = "# Chapter\n\nAlpha **bravo** and *charlie*.\n\n" + duplicate + "\n";
await writeFile(path, source);
let context, page, writes = 0;
const errors = [];
const session = () => JSON.stringify({ version: 13, workMode: "workspace", markdownEditMode: "reading",
  showDirectory: true, workspaceRoot: workspace, openFiles: [path], activePath: path, draftDocuments: [] });
async function start() {
  context = await playwright.chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1360, height: 900 },
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  await context.exposeBinding("qaInvoke", async (_, command, args = {}) => {
    switch (command) {
      case "load_session": return session();
      case "startup_args": return { files: [], directories: [] };
      case "read_workspace": return { root: workspace, name: "Workspace", items: (await readdir(workspace)).map(name => ({
        path: join(workspace, name), name, depth: 0, isDir: false,
      })) };
      case "open_path": {
        const text = await readFile(args.path, "utf8");
        return { path: args.path, title: basename(args.path), text, language: "markdown", lineEnding: "LF", encoding: "UTF-8",
          readOnly: false, largeFile: false, fileSize: Buffer.byteLength(text), diskRevision: "r1" };
      }
      case "file_revisions": return args.paths.map(path => ({ path, revision: "r1" }));
      case "preview_workspace_move": return { ...args.request, token: "test", referenceCount: 0, changedDocuments: [] };
      case "apply_workspace_move":
        await rename(args.request.path, args.request.destination);
        path = args.request.destination;
        return { ...args.request, token: "test", referenceCount: 0, changedDocuments: [] };
      case "pick_save_path": return exportTo;
      case "save_document":
        assert.equal(args.request.path, exportTo);
        assert.ok(args.request.otherOpenPaths.includes(path));
        await writeFile(exportTo, args.request.text);
        writes++;
        return {};
      case "list_snapshots": case "take_open_requests": case "migrate_markdown_assets": return [];
      case "plugin:window|inner_size": return { width: 1360, height: 900 };
      case "plugin:window|scale_factor": case "plugin:event|listen": return 1;
      case "plugin:app|version": return "0.8.10";
      default: return null;
    }
  });
  await context.addInitScript(() => {
    let id = 0;
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: (command, args) => window.qaInvoke(command, args), transformCallback: () => ++id,
      unregisterCallback: () => {}, convertFileSrc: path => path };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  page = context.pages()[0];
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.MARKDOWN_QA_URL ?? "http://127.0.0.1:1421", { waitUntil: "commit", timeout: 120000 });
  await page.locator("#markdownPreview h1").filter({ hasText: "Chapter" }).waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector("#workspace").inert);
}
const action = name => page.getByRole("button", { name, exact: true });
const list = count => action(`批注列表 (${count})`).click();
async function selectText(which) {
  const article = page.locator("#markdownPreview article");
  if (which === "inline") {
    const [from, to] = await article.evaluate(body => [["strong", 1], ["em", 4]].map(([tag, offset]) => {
      const range = document.createRange();
      range.setStart(body.querySelector(tag).firstChild, offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    }));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    return;
  }
  await article.evaluate(body => {
    const text = [...body.querySelectorAll("p")].find(p => p.textContent.includes("needle")).firstChild;
    const start = text.data.indexOf("needle");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 6);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}
try {
  await start();
  await selectText("inline");
  await action("写批注").click();
  await page.getByRole("textbox", { name: "批注内容" }).fill("First note\nSecond line");
  await action("保存批注").click();
  await action("回到原文").click();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), "ravo and char");
  assert.equal(await page.locator("mark.reading-annotation-mark").count(), 3);
  // Cross a paragraph boundary and overlap the existing emphasis mark.
  await page.locator("#markdownPreview article").evaluate(article => {
    const range = document.createRange();
    range.setStartBefore(article.querySelector("em"));
    range.setEnd([...article.querySelectorAll("p")].find(p => p.textContent.includes("needle")).firstChild, 3);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await action("高亮").click();
  await list(2);
  assert.equal(await page.locator("dialog li blockquote").last().textContent(), "charlie.\naaa");
  await action("删除").last().click();
  await action("确认删除").click();
  await action("关闭").click();
  assert.equal(await page.locator("mark.reading-annotation-mark").count(), 3);
  await selectText("needle");
  await action("高亮").click();
  await list(2);
  await action("修改").first().click();
  await page.getByRole("textbox", { name: "批注内容" }).fill("Edited note\nSecond line");
  await action("保存批注").click();
  await action("关闭").click();
  assert.equal(await readFile(path, "utf8"), source);
  await context.close();

  await start();
  await list(2);
  await page.getByText("Edited note", { exact: false }).waitFor();
  await action("关闭").click();
  await page.locator(".tree-item.file").first().click({ button: "right" });
  await page.locator("#treeRenameButton").click();
  await page.getByRole("textbox", { name: "重命名 notes.md" }).fill("moved.md");
  await page.keyboard.press("Enter");
  await page.locator('.tree-item.file').filter({ hasText: "moved.md" }).waitFor();
  await list(2);
  assert.equal(await action("回到原文").count(), 2);
  assert.equal(await readFile(path, "utf8"), source);
  await context.close();

  const moved = join(workspace, "external.md");
  await rename(path, moved);
  path = moved;
  await writeFile(path, "# Chapter\n\n" + duplicate + "\n\n" + duplicate + "\n");
  await start();
  await list(0);
  await page.getByText("关联已移动文件的批注").click();
  await action("将批注移至当前文件").click();
  await page.getByText("Chapter · 原文失效").waitFor();
  await page.getByText("Chapter · 匹配到 2 处").waitFor();
  assert.equal(await page.locator("mark.reading-annotation-mark").count(), 0);
  assert.equal(await page.getByRole("button", { name: "回到原文", disabled: true }).count(), 2);
  const excerptPath = exportTo;
  exportTo = path;
  await action("导出 Markdown 摘录").click();
  await page.getByText(/请选择源文档以外/).waitFor();
  assert.equal(writes, 0);
  exportTo = excerptPath;
  await action("导出 Markdown 摘录").click();
  for (let i = 0; !writes && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 50));
  const excerpt = await readFile(excerptPath, "utf8");
  for (const text of ["ravo and char", "Edited note\nSecond line", "原文失效", "匹配到 2 处"]) assert.ok(excerpt.includes(text));
  assert.equal(await readFile(path, "utf8"), "# Chapter\n\n" + duplicate + "\n\n" + duplicate + "\n");
  await action("关闭").click();
  await selectText("needle");
  await list(2);
  await action("改为当前选区").first().click();
  await action("回到原文").first().click();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), "needle");
  await list(2);
  await action("删除").first().click();
  await action("确认删除").click();
  await action("关闭").click();
  await list(1);
  assert.deepEqual(errors, []);
  console.log("Passed cross-node annotation, edit, jump, process restart, workspace rename, external move, ambiguous/missing anchors, export protection and deletion.");
} catch (error) {
  console.error("Page errors:", errors);
  throw error;
} finally {
  await context?.close();
  await rm(root, { recursive: true, force: true });
}
