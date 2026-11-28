// Run against the built workbench or Vite dev server. The Rust regression test writes
// native.json and the >20 MiB file to OTTERDIVE_SECTION_FIXTURE_DIR (see its test comment).
import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.env.OTTERDIVE_SECTION_FIXTURE_DIR;
if (!dir) throw new Error("Set OTTERDIVE_SECTION_FIXTURE_DIR to the Rust fixture directory");
const { document: dto, index, firstPage, lastPage, search } = JSON.parse(await readFile(join(dir, "native.json"), "utf8"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
const file = await open(join(dir, dto.title), "r");
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  page.setDefaultTimeout(90000);
  const errors = [], reads = [], pageReads = [], cancellations = [];
  let holdIndex, releaseIndex;
  let searchCount = 0;
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.exposeFunction("sectionInvoke", async (cmd, args = {}) => {
    if (["open_path", "read_document_page", "index_markdown_sections", "read_markdown_section", "start_document_search", "cancel_document_page"].includes(cmd)) {
      console.log(cmd, args.start ?? args.request?.line ?? "");
    }
    switch (cmd) {
      case "load_session": return JSON.stringify({ version: 13, openFiles: [dto.path], activePath: dto.path, draftDocuments: [] });
      case "startup_args": return { files: [], directories: [] };
      case "list_snapshots": case "take_open_requests": return [];
      case "open_path": assert.equal(args.path, dto.path); return dto;
      case "file_revisions": return [{ path: dto.path, revision: dto.diskRevision }];
      case "index_markdown_sections":
        assert.equal(args.request.revision, dto.diskRevision);
        if (holdIndex) { holdIndex(); await new Promise(resolve => { releaseIndex = resolve; }); }
        return index;
      case "cancel_document_page": cancellations.push(args.requestId); return;
      case "read_document_page":
        pageReads.push(args.request);
        return args.request.line >= lastPage.startLine ? lastPage : firstPage;
      case "read_markdown_section": {
        const { start, end } = args;
        assert.ok(end - start <= index.sectionLimit);
        const buffer = Buffer.alloc(end - start);
        assert.equal((await file.read(buffer, 0, buffer.length, start)).bytesRead, buffer.length);
        reads.push(buffer.length);
        return buffer.toString("utf8");
      }
      case "start_document_search":
        assert.equal(args.request.documents[0].path, dto.path);
        assert.equal(args.request.options.query, "尾部唯一命中词");
        searchCount++;
        return { report: search, done: true, cancelled: false, truncated: false };
      case "plugin:window|scale_factor": case "plugin:event|listen": return 1;
      case "plugin:window|inner_size": return { width: 1280, height: 900 };
      case "plugin:app|version": return "0.8.10-qa";
      default: return null;
    }
  });
  await page.addInitScript(() => {
    let id = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++id, unregisterCallback() {}, convertFileSrc: path => path,
      async invoke(cmd, args) {
        if (cmd === "start_document_search") {
          const event = await window.sectionInvoke(cmd, { request: args.request });
          setTimeout(() => args.onEvent.onmessage(event), 0);
          return 1;
        }
        return window.sectionInvoke(cmd, args);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  await page.goto(process.env.MARKDOWN_QA_URL ?? "http://127.0.0.1:1420", { waitUntil: "commit" });
  const toggle = page.locator("#pagedSectionToggle");
  const body = page.locator("#pagedSectionBody");
  const select = page.locator("#pagedSectionSelect");
  const filter = page.locator("#pagedSectionFilter");
  await toggle.waitFor({ state: "visible" });
  await page.locator("#pagedDocumentStatus").filter({ hasText: "源行" }).waitFor();
  const start = performance.now();
  await toggle.click();
  await body.locator("h1").filter({ hasText: "重复" }).waitFor();
  const firstPaint = performance.now() - start;
  assert.equal(await body.locator("h1").count(), 1);
  assert.match(await body.locator("pre").innerText(), /伪标题/);
  assert.equal(await body.locator('a[href="https://example.org/manual"]').count(), 1);
  assert.match(await body.locator(".footnotes").innerText(), /跨章节脚注正文/);
  await page.screenshot({ path: join(dir, "chapter.png") });
  await body.locator("sup a").click();
  await body.locator(".footnote-backref").click();
  assert.equal(await page.locator("#editor").isVisible(), false);
  const regularStart = performance.now();
  await page.locator("#pagedSectionNext").click();
  await body.getByRole("heading", { name: "小节 0", exact: true }).waitFor();
  const regularPaint = performance.now() - regularStart;
  assert.equal(await body.locator("article").count(), 1);
  assert.equal(await body.locator("article > p").count(), 80);
  const readsBeforeOversize = reads.length;
  await filter.fill("超长章");
  await select.selectOption("241");
  await body.getByRole("alert").filter({ hasText: "256 KiB" }).waitFor();
  assert.equal(await body.locator("article").count(), 0);
  assert.equal(reads.length, readsBeforeOversize);
  await page.screenshot({ path: join(dir, "oversize.png") });
  await page.locator("#pagedSectionNext").click();
  await body.getByText("尾部唯一命中词").waitFor();
  assert.equal(await body.locator("h1").getAttribute("id"), "重复-1");
  await filter.fill("重复");
  assert.deepEqual(await select.locator("option").evaluateAll(nodes => nodes.map(n => n.value)), ["0", "242"]);
  await select.selectOption("0");
  await body.locator(".footnotes").waitFor();
  assert.equal(await body.locator("article").count(), 1);
  await body.getByRole("link", { name: "去第二个同名标题" }).click();
  await body.getByText("尾部唯一命中词").waitFor();
  await filter.fill("重复");
  await select.selectOption("0");
  await body.locator(".footnotes").waitFor();
  await page.keyboard.press("Control+f");
  await page.locator("#currentFindInput").fill("尾部唯一命中词");
  await page.locator("#currentFindAllButton").click();
  const hit = page.locator('.find-result-row[role="button"]').filter({ hasText: "尾部唯一命中词" }).first();
  await hit.click();
  await page.locator("#editor").waitFor({ state: "visible" });
  await page.locator("#pagedDocumentStatus").filter({ hasText: String(lastPage.startLine) }).waitFor();
  assert.ok(pageReads.some(req => req.line === index.sections.at(-1).line + 2));
  assert.ok(searchCount > 0);
  const indexStarted = new Promise(resolve => { holdIndex = resolve; });
  await toggle.click();
  await Promise.race([indexStarted, new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Expected a cancellable index request")), 10000).unref();
  })]);
  await page.locator("#pagedSectionCancel").click();
  await page.locator("#pagedSectionStatus").filter({ hasText: "已取消" }).waitFor();
  releaseIndex();
  await toggle.click();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.ok(cancellations.length);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ fileBytes: dto.fileSize, sections: index.sections.length, firstClickToHeadingMs: Math.round(firstPaint),
    regularClickToHeadingMs: Math.round(regularPaint), sectionReadBytes: reads, searchMatchLine: index.sections.at(-1).line + 2, pageErrors: errors }, null, 2));
} finally {
  await file.close();
  await browser.close();
}
