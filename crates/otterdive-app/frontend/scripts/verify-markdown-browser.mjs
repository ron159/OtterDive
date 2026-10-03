// Run against `npm run dev`. Supply PLAYWRIGHT_MODULE when Playwright is not installed locally.
// Uses a new browser/profile; never connects to an existing personal or test browser.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const baseUrl = process.env.MARKDOWN_QA_URL ?? "http://127.0.0.1:1420";
const artifactDirectory = process.env.MARKDOWN_QA_ARTIFACT_DIR;
if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
const networkRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
context.on("request", (request) => {
  if (/^https?:/.test(request.url()) && !request.url().startsWith(baseUrl)) networkRequests.push(request.url());
});
await context.route(`${baseUrl}/markdown-qa.html`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Markdown isolated QA</title></head>
<body><main id="scroller" style="height:680px;width:900px;overflow:auto;margin:20px auto"><div id="host"></div></main>
<section id="preview" style="display:none;height:680px;width:900px;overflow:auto;margin:20px auto"></section>
<section id="source" style="display:none;height:680px;width:900px;margin:20px auto"></section></body></html>` }));

try {
  await page.goto(`${baseUrl}/markdown-qa.html`);
  await page.evaluate(async () => {
    window.MUYA_VERSION = "browser-qa";
    await import("/src/styles.css");
    const editor = await import("/src/markdownEditor.ts");
    const print = await import("/src/markdownPrint.ts");
    const diagram = await import("/src/markdownDiagramExport.ts");
    const monaco = await import("/node_modules/.vite/deps/monaco-editor_esm_vs_editor_editor__api.js");
    const markdownLanguage = await import("/node_modules/monaco-editor/esm/vs/basic-languages/markdown/markdown.js");
    const { default: EditorWorker } = await import("/node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker");
    window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
    monaco.languages.register({ id: "markdown" });
    monaco.languages.setLanguageConfiguration("markdown", markdownLanguage.conf);
    monaco.languages.setMonarchTokensProvider("markdown", markdownLanguage.language);
    document.body.style.cssText = "display:block;height:auto;overflow:auto";
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.qa = {
      editor, print, diagram, frame, bridge: null, changes: [], inputStart: null, inputPaint: null,
      sourceModel: monaco.editor.createModel("", "markdown"),
      sourceEditor: monaco.editor.create(document.querySelector("#source"), {
        value: "", language: "markdown", automaticLayout: false, fontSize: 16,
        minimap: { enabled: false }, wordWrap: "off",
      }),
      mount(markdown, writingOptions = {}) {
        this.bridge?.destroy();
        const scroller = document.querySelector("#scroller");
        scroller.innerHTML = '<div id="host"></div>';
        scroller.scrollTop = 0;
        this.changes = [];
        this.bridge = new editor.MarkdownEditorBridge({
          element: document.querySelector("#host"), markdown, darkMode: false,
          fontSize: 16, fontFamily: "sans-serif", readOnly: false,
          pickImagePath: async () => "", resolveImageSrc: (src) => src,
          openLink: () => {}, onHeadingAnchorCopied: () => {},
          onChange: (markdown) => {
            this.changes.push({ markdown, time: performance.now() });
            if (this.inputStart !== null && !this.inputPaint) this.inputPaint = frame().then(() => performance.now() - this.inputStart);
          },
          writingOptions: { plantumlServer: "", ...writingOptions },
        });
        return this.bridge;
      },
      caret(paragraphIndex = 0, offset = 0) {
        const content = this.bridge.root.querySelectorAll(".mu-paragraph > .mu-content")[paragraphIndex];
        if (!content) throw new Error(`Paragraph ${paragraphIndex} not found`);
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text) throw new Error("Paragraph has no text node");
        this.bridge.root.focus();
        const range = document.createRange();
        range.setStart(text, Math.min(offset, text.length));
        range.collapse(true);
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
      },
    };
  });

  const fixture = "# 中文标题\n\n[TOC]\n\n# 中文标题\n\n> [!NOTE]\n> 中文提示\n\n正文 ==重点 **加粗**==，脚注[^注]。\n\n| 名称 | 值 |\n| --- | --- |\n| 中文 | 甲 |\n\n$$\n\\ce{H2O}\\label{eq:water}\n$$\n\n公式 $\\eqref{eq:water}$ 。\n\n[^注]: 脚注内容\n\n![本地](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5z8AAAAASUVORK5CYII=)\n";
  const functional = await page.evaluate(async (markdown) => {
    const { qa } = window;
    qa.mount(markdown, { spellcheckLanguage: "en-GB" });
    await qa.frame();
    const saved = qa.bridge.getMarkdown();
    const result = {
      toc: qa.bridge.root.querySelectorAll(".markdown-live-toc a").length,
      alerts: qa.bridge.root.querySelectorAll(".markdown-alert").length,
      marks: qa.bridge.root.querySelectorAll("mark").length,
      spellcheckLanguage: qa.bridge.root.lang,
      spellcheck: qa.bridge.root.getAttribute("spellcheck"),
      roundtripContains: ["[TOC]", "[!NOTE]", "==重点 **加粗**==", "\\label{eq:water}", "[^注]"].every((s) => saved.includes(s)),
    };
    const preview = document.querySelector("#preview");
    preview.innerHTML = qa.editor.renderMarkdownPreviewHtml(markdown, { darkMode: false });
    result.previewToc = preview.querySelectorAll(".markdown-toc a").length;
    result.previewMarks = preview.querySelectorAll("mark").length;
    result.previewAlerts = preview.querySelectorAll(".markdown-alert").length;
    result.headingIds = [...preview.querySelectorAll("h1")].map((h) => h.id);
    result.mathErrors = preview.querySelectorAll(".katex-error").length;
    const disabled = document.createElement("div");
    disabled.innerHTML = qa.editor.renderMarkdownPreviewHtml(markdown, { darkMode: false, extensions: {
      footnote: false, math: false, superSubScript: false, frontMatter: false, highlight: false, alerts: false, toc: false,
    } });
    result.disabledDecorations = disabled.querySelectorAll("mark,.markdown-alert,.markdown-toc,.katex").length;
    return result;
  }, fixture);
  console.log("functional", JSON.stringify(functional));
  assert.equal(functional.toc, 2);
  assert.equal(functional.alerts, 1);
  assert.equal(functional.marks, 1);
  assert.equal(functional.roundtripContains, true);
  assert.equal(functional.previewToc, 2);
  assert.equal(functional.previewMarks, 1);
  assert.equal(functional.previewAlerts, 1);
  assert.deepEqual(functional.headingIds, ["中文标题", "中文标题-1"]);
  assert.equal(functional.mathErrors, 0);
  assert.equal(functional.disabledDecorations, 0);
  if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, "markdown-live.png") });

  await page.evaluate(async () => { window.qa.mount("第一段中文内容。\n\n第二段用于输入。\n\n第三段用于检查。", { focusMode: true }); await window.qa.frame(); window.qa.caret(1, 4); });
  await page.keyboard.insertText("测试输入");
  await page.waitForFunction(() => {
    const paragraphs = [...window.qa.bridge.root.querySelectorAll(".mu-container > *")];
    return paragraphs.some((p) => p.classList.contains("mu-active") && getComputedStyle(p).opacity === "1")
      && paragraphs.some((p) => !p.classList.contains("mu-active") && Number(getComputedStyle(p).opacity) < 0.3);
  });
  const editing = await page.evaluate(async () => {
    const { qa } = window;
    const value = qa.bridge.getMarkdown();
    const opacity = [...qa.bridge.root.querySelectorAll(".mu-container > *")].map((p) => ({ active: p.classList.contains("mu-active"), opacity: getComputedStyle(p).opacity }));
    const state = JSON.parse(JSON.stringify(qa.bridge.captureSessionState()));
    qa.mount(value);
    qa.bridge.restoreSessionState(state, `${value}\n\n源码追加内容。`, true);
    const latestWon = qa.bridge.getMarkdown().includes("源码追加内容");
    qa.bridge.undo();
    const undoSource = !qa.bridge.getMarkdown().includes("源码追加内容");
    qa.bridge.redo();
    const redoSource = qa.bridge.getMarkdown().includes("源码追加内容");
    qa.bridge.setReadOnly(true);
    const readOnlyLeaves = qa.bridge.root.querySelectorAll('[contenteditable="true"]').length;
    return { inputPreserved: value.includes("测试输入"), opacity, latestWon, undoSource, redoSource, readOnlyLeaves, beforeReadonlyInput: qa.bridge.getMarkdown() };
  });
  await page.keyboard.insertText("不应进入正文");
  const afterReadonlyInput = await page.evaluate(() => window.qa.bridge.getMarkdown());
  assert.equal(afterReadonlyInput, editing.beforeReadonlyInput);
  assert.equal(editing.inputPreserved, true);
  assert.equal(editing.latestWon, true);
  assert.equal(editing.undoSource, true);
  assert.equal(editing.redoSource, true);
  assert.equal(editing.readOnlyLeaves, 0);
  assert.ok(editing.opacity.some((item) => item.active && item.opacity === "1"));
  assert.ok(editing.opacity.some((item) => !item.active && Number(item.opacity) < 0.5));
  delete editing.beforeReadonlyInput;
  console.log("editing", JSON.stringify(editing));

  const typewriter = await page.evaluate(async () => {
    const { qa } = window;
    qa.mount(Array.from({ length: 50 }, (_, i) => `第${i}段用于检查打字机模式，中文正文。`).join("\n\n"), { typewriterMode: true });
    await qa.frame();
    qa.caret(25, 5);
    await qa.frame();
    const caret = document.getSelection().getRangeAt(0).getBoundingClientRect();
    const scroller = document.querySelector("#scroller");
    const box = scroller.getBoundingClientRect();
    return { caretTopFraction: (caret.top - box.top) / box.height, scrollTop: scroller.scrollTop };
  });
  assert.ok(typewriter.scrollTop > 0);
  assert.ok(Math.abs(typewriter.caretTopFraction - 0.45) < 0.03);
  console.log("typewriter", JSON.stringify(typewriter));
  if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, "markdown-typewriter.png") });

  const cursor = await page.evaluate(async () => {
    const { qa } = window;
    qa.mount("# 标题\n\n正文中文\n\n> 引用正文\n\n- 列表正文\n");
    await qa.frame();
    const node = qa.bridge.root.querySelector(".mu-content");
    const backward = { anchor: { line: 2, ch: 4 }, focus: { line: 2, ch: 1 } };
    const restored = qa.bridge.setCursorOffset(backward);
    const readback = qa.bridge.getCursorOffset();
    const retainedDom = node === qa.bridge.root.querySelector(".mu-content");
    return { restored, retainedDom, readback, expected: backward };
  });
  assert.equal(cursor.restored, true);
  assert.equal(cursor.retainedDom, true);
  assert.deepEqual(cursor.readback, cursor.expected);
  console.log("cursor", JSON.stringify(cursor));

  const exports = await page.evaluate(async (markdown) => {
    const { qa } = window;
    const warning = [];
    const exported = await qa.print.createMarkdownHtmlExport({ title: "中文导出.md", markdown,
      renderHtml: (source) => qa.editor.renderMarkdownPreviewHtml(source, { darkMode: false }),
      renderDiagrams: (root) => qa.editor.renderMarkdownPreviewDiagrams(root, { darkMode: false, plantumlServer: "" }),
      onResourceWarning: (message) => warning.push(message),
      layout: { paperSize: "Letter", marginMm: 20, header: "页眉测试", footer: "页脚测试", pageNumbers: true },
    });
    const parsed = new DOMParser().parseFromString(exported.html, "text/html");
    qa.exportHtml = exported.html;
    const diagram = document.querySelector("#preview");
    diagram.style.display = "block";
    diagram.innerHTML = qa.editor.renderMarkdownPreviewHtml("```mermaid\ngraph TD\n A[开始] --> B[结束]\n```", { darkMode: false });
    await qa.editor.renderMarkdownPreviewDiagrams(diagram, { darkMode: false, plantumlServer: "" });
    const svg = await qa.diagram.createMarkdownDiagramExport(diagram, "svg");
    const png = await qa.diagram.createMarkdownDiagramExport(diagram, "png");
    diagram.style.display = "none";
    return { headingCount: exported.headingCount, title: parsed.title, toc: parsed.querySelectorAll(".markdown-toc a").length,
      embeddedImages: [...parsed.querySelectorAll("img")].every((img) => img.src.startsWith("data:")),
      scripts: parsed.querySelectorAll("script").length, layout: exported.html.includes("size: Letter portrait"),
      printTreeCleaned: document.querySelectorAll(".markdown-print-root").length === 0,
      svgBytes: svg.size, pngBytes: png.size, pngType: png.type, warnings: warning };
  }, fixture);
  assert.equal(exports.title, "中文导出");
  assert.equal(exports.headingCount, 2);
  assert.equal(exports.toc, 2);
  assert.equal(exports.embeddedImages, true);
  assert.equal(exports.scripts, 0);
  assert.equal(exports.layout, true);
  assert.equal(exports.printTreeCleaned, true);
  assert.ok(exports.svgBytes > 100 && exports.pngBytes > 100);
  console.log("exports", JSON.stringify(exports));
  const exportHtml = await page.evaluate(() => { const html = window.qa.exportHtml; delete window.qa.exportHtml; return html; });
  const exportPage = await context.newPage();
  await exportPage.setContent(exportHtml);
  await exportPage.evaluate(() => document.fonts.ready);
  const pdf = await exportPage.pdf({ preferCSSPageSize: true, printBackground: true });
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from("%PDF-")));
  exports.pdfBytes = pdf.length;
  exports.pdfPages = [...pdf.toString("latin1").matchAll(/\/Type \/Page\b/g)].length;
  assert.ok(exports.pdfPages > 0);
  if (artifactDirectory) {
    await writeFile(join(artifactDirectory, "markdown-export.html"), exportHtml);
    await writeFile(join(artifactDirectory, "markdown-export.pdf"), pdf);
  }
  await exportPage.close();

  const samples = [];
  const session = await context.newCDPSession(page);
  await session.send("Performance.enable");
  for (const chineseCharacters of [10000, 50000, 100000]) for (let repetition = 1; repetition <= 3; repetition++) {
    const measurement = await page.evaluate(async (size) => {
      const { qa } = window;
      const text = "中文编辑阅读测试内容段落格式保持性能体验".repeat(Math.ceil(size / 20)).slice(0, size);
      const paragraphs = text.match(/.{1,100}/gu) ?? [];
      const markdown = "[TOC]\n\n" + paragraphs.map((paragraph, i) => (i % 20 === 0 ? `## Section ${i / 20}\n\n` : "") + paragraph).join("\n\n");
      qa.sourceModel.setValue(markdown);
      qa.sourceEditor.setModel(qa.sourceModel);
      const start = performance.now();
      qa.mount(markdown);
      const constructorMs = performance.now() - start;
      await qa.frame();
      const renderMs = performance.now() - start;
      const preview = document.querySelector("#preview");
      document.querySelector("#scroller").style.display = "none";
      preview.style.display = "block";
      const previewStart = performance.now();
      preview.innerHTML = qa.editor.renderMarkdownPreviewHtml(markdown, { darkMode: false });
      await qa.frame();
      const previewMs = performance.now() - previewStart;
      preview.style.display = "none";
      document.querySelector("#scroller").style.display = "block";
      await qa.frame();
      qa.caret(Math.floor(paragraphs.length / 2), 20);
      qa.inputStart = null;
      qa.inputPaint = null;
      qa.bridge.root.addEventListener("beforeinput", () => { qa.inputStart = performance.now(); }, { once: true });
      qa.changes = [];
      return { chineseCharacters: (text.match(/\p{Script=Han}/gu) ?? []).length, paragraphs: paragraphs.length,
        sourceLength: markdown.length, constructorMs, renderMs, previewMs };
    }, chineseCharacters);
    await page.keyboard.insertText("新增中文");
    await page.waitForFunction(() => window.qa.changes.length > 0);
    Object.assign(measurement, await page.evaluate(async () => {
      const { qa } = window;
      const inputMs = await qa.inputPaint;
      const inputChangeMs = qa.changes[0].time - qa.inputStart;
      qa.sourceModel.setValue(qa.bridge.getMarkdown());
      const start = performance.now();
      const state = qa.bridge.captureSessionState();
      const json = JSON.stringify(state);
      qa.bridge.destroy();
      qa.bridge = null;
      document.querySelector("#scroller").style.display = "none";
      document.querySelector("#source").style.display = "block";
      qa.sourceEditor.layout();
      qa.sourceEditor.setPosition({ lineNumber: state.cursor.anchor.line + 1, column: state.cursor.anchor.ch + 1 });
      qa.sourceEditor.revealPositionInCenter(qa.sourceEditor.getPosition());
      await qa.frame();
      const toSourceMs = performance.now() - start;
      const returnStart = performance.now();
      document.querySelector("#source").style.display = "none";
      document.querySelector("#scroller").style.display = "block";
      qa.mount(qa.sourceModel.getValue());
      qa.bridge.restoreSessionState(JSON.parse(json), qa.sourceModel.getValue());
      await qa.frame();
      const toLiveMs = performance.now() - returnStart;
      return { inputChangeMs, inputMs, toSourceMs, toLiveMs, serializedHistoryBytes: new Blob([json]).size,
        preservesInput: qa.bridge.getMarkdown().includes("新增中文") };
    }));
    await session.send("HeapProfiler.collectGarbage");
    const { metrics } = await session.send("Performance.getMetrics");
    measurement.repetition = repetition;
    measurement.jsHeapUsedMiB = metrics.find((metric) => metric.name === "JSHeapUsedSize").value / 1024 ** 2;
    assert.equal(measurement.chineseCharacters, chineseCharacters);
    assert.equal(measurement.preservesInput, true);
    samples.push(measurement);
    console.log("sample", JSON.stringify(measurement));
  }
  assert.deepEqual(networkRequests, [], "PlantUML disabled and data images must not issue external network requests");
  assert.deepEqual(errors, [], "Browser must not emit uncaught errors");
  const report = { timestamp: new Date().toISOString(), browser: await browser.version(), fixture: "isolated modules, warm imports, 100 Chinese characters/paragraph", functional, editing, typewriter, cursor, exports, samples, errors, externalNetworkRequests: networkRequests };
  if (process.env.MARKDOWN_QA_OUTPUT) await writeFile(process.env.MARKDOWN_QA_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log("Markdown browser QA passed");
} finally {
  await browser.close();
}
