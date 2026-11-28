// Run against the built workbench (npm run preview) with PLAYWRIGHT_MODULE set if needed.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const baseUrl = process.env.MARKDOWN_QA_URL ?? "http://127.0.0.1:1420";
const engine = process.env.MARKDOWN_QA_ENGINE ?? "chromium";
const browser = await playwright[engine].launch({
  headless: true,
  executablePath: engine === "chromium" ? process.env.CHROME_EXECUTABLE : process.env.WEBKIT_EXECUTABLE,
});
try {
  for (const macOS of [true, false]) {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 840 },
      userAgent: macOS ? "Mozilla/5.0 (Macintosh; Mac OS X)" : "Mozilla/5.0 (Windows NT 10.0)",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const external = [], reads = [], errors = [];
    page.on("pageerror", err => errors.push(err.message));
    await context.route(/^https?:\/\//, route => {
      if (new URL(route.request().url()).origin === new URL(baseUrl).origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const root = "/qa/reader.md", opened = "/qa/open.md", linked = "/qa/中文 笔记.md";
    const href = encodeURIComponent("中文 笔记.md") + "#" + encodeURIComponent("标题-1");
    const files = new Map([
      [root, `# 首页\n\n[同页](#首页) [章节](${href}) [整篇](open.md) [慢速](slow.md) [超限](big.md#超限) [网页](https://example.invalid/foo.md) [缺失](missing.md)\n\n脚注[^甲]，再见[^甲]。\n\n`
        + "段落。\n\n".repeat(80) + "[^甲]: 同一个**脚注定义**。"],
      [opened, "# 已打开的笔记\n\n内容来自已打开的文档。"],
      [linked, [
        "## 标题", "第一节不能出现", "## 标题", "精确命中**第二节**。",
        "![联网图片](https://example.invalid/pixel.png)",
        '<video poster="https://example.invalid/poster"><source src="https://example.invalid/movie"></video>',
        '<img srcset="https://example.invalid/image 1x"><iframe src="https://example.invalid/frame"></iframe>',
        '<p style="background-image:url(https://example.invalid/style)">外部资源测试</p>',
        "```plantuml\n@startuml\nAlice -> Bob\n@enduml\n```", "## 下一节", "下一节不能出现",
      ].join("\n\n")],
      ["/qa/big.md", "x".repeat(40_000) + "\n\n## 超限"],
    ]);
    let releaseRead;
    async function waitForSlowRead() {
      const deadline = Date.now() + 5000;
      while (!releaseRead && Date.now() < deadline) await page.waitForTimeout(20);
      assert.ok(releaseRead, "expected pending slow.md read");
    }
    await context.exposeBinding("qaInvoke", async (_, command, args = {}) => {
      if (command === "load_session") return JSON.stringify({ version: 13, markdownEditMode: "reading",
        openFiles: [root, opened], activePath: root, draftDocuments: [], workbenchPreferences: { plantumlServer: "https://example.invalid/uml" } });
      if (command === "open_path") {
        const text = files.get(args.path);
        return { path: args.path, title: args.path.split("/").at(-1), text, encoding: "UTF-8", lineEnding: "LF",
          fileSize: Buffer.byteLength(text), language: "markdown", readOnly: false, largeFile: false, diskRevision: "r1" };
      }
      if (command === "read_file_chunk") {
        const { path, offset, limit } = args.request;
        reads.push(path);
        assert.equal(offset, 0);
        assert.ok(limit > 0 && limit <= 32768);
        if (path === "/qa/slow.md") return new Promise(resolve => {
          releaseRead = () => resolve({ text: "# 迟到响应", hasMore: false });
        });
        const text = files.get(path);
        if (text === undefined) throw new Error("missing fixture");
        return { text: text.slice(0, limit), hasMore: text.length > limit };
      }
      if (command === "file_revisions") return args.paths.map(path => ({ path, revision: "r1" }));
      if (["shell_integration_status", "default_app_candidate_status", "set_shell_integration", "set_default_app_candidate"].includes(command)) {
        return { supported: true, enabled: false, label: "", detail: "" };
      }
      if (command === "startup_args") return { files: [], directories: [] };
      if (command === "plugin:app|version") return "0.0.0-qa";
      if (command === "plugin:window|inner_size") return { width: 1200, height: 840 };
      if (command === "plugin:window|scale_factor" || command === "plugin:event|listen") return 1;
      if (["list_snapshots", "take_open_requests"].includes(command)) return [];
      return null;
    });
    await context.addInitScript(() => {
      let id = 0;
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        invoke: (cmd, args) => window.qaInvoke(cmd, args), transformCallback: () => ++id, unregisterCallback() {}, convertFileSrc: path => path };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    const pane = page.locator("#markdownPreview"), tip = page.locator(".markdown-link-popover");
    const link = name => pane.getByRole("link", { name, exact: true });
    async function visible(value) {
      try { await tip.filter({ hasText: value }).waitFor(); }
      catch (error) {
        console.error(await page.evaluate(() => ({ focus: document.activeElement?.outerHTML.slice(0, 240),
          tooltip: document.querySelector(".markdown-link-popover")?.outerHTML.slice(0, 240) })), { reads, errors });
        throw error;
      }
    }
    const key = macOS ? "Meta" : "Control";
    await link("同页").waitFor({ timeout: 60000 });
    await link("同页").hover();
    await page.keyboard.down(key);
    await visible("首页");
    await page.keyboard.up(key);
    await tip.waitFor({ state: "hidden" });
    await link("章节").hover();
    assert.equal(await tip.isVisible(), false);
    await page.keyboard.down(key);
    await visible("精确命中第二节");
    assert.doesNotMatch(await tip.innerText(), /第一节不能出现|下一节不能出现/);
    assert.equal(await tip.locator("img,video,iframe,svg,a").count(), 0);
    assert.deepEqual(reads, [linked]);
    if (macOS && process.env.MARKDOWN_QA_SCREENSHOT) await page.screenshot({ path: process.env.MARKDOWN_QA_SCREENSHOT });
    await tip.hover();
    await visible("精确命中第二节");
    await page.keyboard.press("Escape");
    await tip.waitFor({ state: "hidden" });
    await page.keyboard.up(key);

    await link("同页").focus();
    await page.keyboard.press("Tab");
    await visible("精确命中第二节");
    assert.equal(await link("章节").getAttribute("aria-describedby"), await tip.getAttribute("id"));
    await page.keyboard.press("Tab");
    await visible("内容来自已打开的文档");
    assert.ok(!reads.includes(opened));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await waitForSlowRead();
    await page.keyboard.press("Tab");
    await visible("预览范围内未找到此标题");
    releaseRead();
    releaseRead = null;
    await page.waitForTimeout(80);
    await visible("预览范围内未找到此标题");
    await page.keyboard.press("Tab");
    await tip.waitFor({ state: "hidden" });
    await page.keyboard.down(key);
    await link("网页").hover();
    assert.equal(await tip.isVisible(), false);
    await link("缺失").hover();
    await visible("无法读取此文档");
    await page.keyboard.up(key);
    const footnote = pane.locator(".footnote-ref a").last();
    await footnote.hover();
    await visible("同一个脚注定义");
    assert.doesNotMatch(await tip.innerText(), /↩/);
    await footnote.click();
    await page.waitForFunction(() => {
      const pane = document.querySelector("#markdownPreview");
      const note = pane.querySelector("#fn-1").getBoundingClientRect();
      return note.top >= pane.getBoundingClientRect().top && note.bottom <= pane.getBoundingClientRect().bottom;
    });

    await link("整篇").focus();
    await page.keyboard.press("Tab");
    await waitForSlowRead();
    await page.getByRole("tab", { name: /open.md/ }).locator(".tab-title").click();
    try { await pane.getByRole("heading", { name: "已打开的笔记" }).waitFor(); }
    catch (error) {
      console.error({ tabs: await page.locator("#tabs").innerText(), activeTab: await page.locator("#tabs .active").innerText(),
        preview: (await pane.innerText()).slice(0, 150), errors });
      throw error;
    }
    releaseRead();
    await page.waitForTimeout(150);
    assert.equal(await tip.isVisible(), false);
    await page.getByRole("tab", { name: /reader.md/ }).locator(".tab-title").click();
    await page.locator("#markdownSplitButton").click();
    await link("章节").hover({ modifiers: [key] });
    assert.equal(await tip.isVisible(), false);
    await page.locator("#markdownReadingButton").click();
    await link("整篇").click();
    await pane.getByRole("heading", { name: "已打开的笔记" }).waitFor();
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(`${engine} ${key}: link, footnote, keyboard, navigation, stale read, size and network checks passed`);
    await context.close();
  }
} finally {
  await browser.close();
}
