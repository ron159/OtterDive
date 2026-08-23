import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const markdownPrint = await loadTypeScriptModule("../src/markdownPrint.ts");
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const markdownEditorSource = fs.readFileSync(new URL("../src/markdownEditor.ts", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../../src/app.rs", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const capabilities = JSON.parse(
  fs.readFileSync(new URL("../../capabilities/default.json", import.meta.url), "utf8"),
);

test("uses a clean Markdown title as the suggested PDF name", () => {
  assert.equal(markdownPrint.markdownPrintTitle("Guide.md"), "Guide");
  assert.equal(markdownPrint.markdownPrintTitle(" 设计说明.markdown "), "设计说明");
  assert.equal(markdownPrint.markdownPrintTitle(""), "OtterDive Markdown");
  assert.equal(markdownPrint.markdownPdfFileName("Guide.md"), "Guide.pdf");
});

test("namespaces only valid internal print targets", () => {
  const targets = markdownPrint.createPrintTargetMap(
    ["overview", "章节", "unused"],
    ["#overview", "#%E7%AB%A0%E8%8A%82", "#missing", "https://example.com/#overview"],
    "otterdive-print-7",
  );
  assert.deepEqual([...targets], [
    ["overview", "otterdive-print-7-overview"],
    ["章节", "otterdive-print-7-章节"],
  ]);
});

test("wires outline export and system printing through the app", () => {
  assert.match(mainSource, /command\("file\.exportPdf", "导出带大纲 PDF"/);
  assert.match(mainSource, /command\("file\.print", "系统打印"/);
  assert.match(mainSource, /invoke<string>\("export_pdf_with_outline"/);
  assert.match(mainSource, /renderMarkdownPreviewDiagrams/);
  assert.match(mainSource, /refreshMarkdownResources\(root, doc\)/);
  assert.match(appSource, /"file\.export_pdf"/);
  assert.match(appSource, /"file\.print"/);
  assert.match(appSource, /crate::pdf_export::export_pdf_with_outline/);
  assert.match(stylesSource, /@media print/);
  assert.ok(capabilities.permissions.includes("core:webview:allow-print"));
});

test("reserves existing footnote targets before assigning heading ids", () => {
  assert.match(markdownEditorSource, /querySelectorAll<HTMLElement>\("\[id\]"\)/);
  assert.match(markdownEditorSource, /filter\(\(element\) => !headingSet\.has\(element\)\)/);
  assert.match(markdownEditorSource, /preservedHeadingIds\.add\(existingId\)/);
  assert.match(markdownEditorSource, /emittedHeadingIds\.add\(existingId\)/);
});

test("does not count front matter as a Markdown heading", () => {
  assert.match(mainSource, /const frontMatterEnd = frontMatterMarkers\[lines\[0\] \?\? ""\]/);
  assert.match(mainSource, /for \(let index = contentStart; index < lines\.length/);
});

async function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}
