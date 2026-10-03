import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { Marked } from "marked";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as json1 from "ot-json1";

async function load(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}
const { default: markExtension } = await load("../vendor/marktext-muya/src/utils/marked/extensions/mark.ts");

async function bundle(relativePath) {
  const output = await build({ entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
}

test("highlight nests inline formatting without interpreting code or escaped delimiters", () => {
  const parser = new Marked(markExtension());
  assert.equal(parser.parseInline("==重点 **strong**=="), "<mark>重点 <strong>strong</strong></mark>");
  assert.equal(parser.parseInline("`==code==`"), "<code>==code==</code>");
  assert.equal(parser.parseInline("\\==literal=="), "==literal==");
  assert.equal(parser.parseInline("== spaced =="), "== spaced ==");
  assert.equal(parser.parse("```\n==code==\n```"), "<pre><code>==code==\n</code></pre>\n");
});

test("equation labels ignore fenced examples and preserve explicit tags", async () => {
  const math = await load("../vendor/marktext-muya/src/utils/equationReferences.ts");
  const labels = math.collectEquationLabels("```tex\n$$\n\\label{ignored}\n$$\n```\n\n$$\nx=1\\label{eq:first}\n$$\n\n$$\ny=2\\tag{A}\\label{eq:custom}\n$$");
  assert.deepEqual(labels, { "eq:first": "1", "eq:custom": "A" });
  assert.equal(math.prepareEquationTex("x=1\\label{eq:first}", labels, true), "x=1\\tag{1}");
  assert.equal(math.prepareEquationTex("\\eqref{eq:first}+\\ref{eq:custom}", labels, false), "\\text{(1)}+\\text{A}");
  assert.equal(math.prepareEquationTex("\\eqref{missing}", labels, false), "\\text{??}");
  assert.equal(math.prepareEquationTex("x\\tag{A}\\label{eq:custom}", labels, true), "x\\tag{A}");
  assert.deepEqual(math.collectEquationLabels("---\nexample: |\n  $$\n  \\label{ignored}\n  $$\n---\n```math\nx\\label{gitlab}\n```"), { gitlab: "1" });
});

test("live highlight tokens preserve exact source and readable heading text", async () => {
  const lexer = await bundle("../vendor/marktext-muya/src/inlineRenderer/lexer.ts");
  for (const source of ["==重点 **加粗**==", "`==code==`", "\\==literal==", "== spaced ==", "==escaped\\=="]) {
    const tokens = lexer.tokenizer(source, { hasBeginRules: false, options: { superSubScript: true, footnote: true, highlight: true } });
    assert.equal(lexer.generator(tokens), source);
    if (source.startsWith("==重点")) {
      assert.equal(tokens[0].type, "mark");
      assert.equal(lexer.tokensToPlainText(tokens), "重点 加粗");
    } else assert.ok(tokens.every((token) => token.type !== "mark"), source);
  }
});

test("TOC links escape titles and alerts require a complete supported marker", async () => {
  const decorations = await load("../src/markdownDecorations.ts");
  const html = decorations.markdownTocHtml([{ level: 2, text: '<img src=x onerror="x">', id: "章节 space" }]);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /#%E7%AB%A0%E8%8A%82%20space/);
  assert.equal(decorations.markdownAlertType("[!NOTE]\n说明"), "NOTE");
  assert.equal(decorations.markdownAlertType("[!OTHER]\n说明"), null);
  assert.equal(decorations.markdownAlertType("[!WARNING]suffix"), null);
});

test("TOC markers are recognized from Markdown syntax rather than rendered code or escaped text", async () => {
  const { getHighlightHtml } = await bundle("../vendor/marktext-muya/src/utils/marked/getHighlightHtml.ts");
  assert.match(getHighlightHtml("[TOC]", { toc: true }), /otterdive-toc-marker/);
  for (const markdown of ["`[TOC]`", "\\[TOC]", "**[TOC]**", "```\n[TOC]\n```", "<pre>\n[TOC]\n</pre>"]) {
    assert.doesNotMatch(getHighlightHtml(markdown, { toc: true }), /otterdive-toc-marker/, markdown);
  }
  assert.match(getHighlightHtml("> [!NOTE]\n> 提示", { alerts: true }), /otterdive-alert-marker/);
  for (const markdown of ["> `[!NOTE]`", "> \\[!NOTE]", "> **[!NOTE]**", "> [!OTHER]"]) {
    assert.doesNotMatch(getHighlightHtml(markdown, { alerts: true }), /otterdive-alert-marker/, markdown);
  }
});

test("diagram PNG export is bounded for very large diagrams", async () => {
  const { diagramExportSize } = await load("../src/markdownDiagramExport.ts");
  assert.deepEqual(diagramExportSize(600, 400), { width: 1200, height: 800 });
  const size = diagramExportSize(30_000, 20_000);
  assert.ok(size.width <= 4096 && size.height <= 4096 && size.width * size.height <= 16_010_000);
  assert.throws(() => diagramExportSize(0, 0), /尚未完成渲染/);
  assert.throws(() => diagramExportSize(Infinity, 20), /尚未完成渲染/);
});

test("Markdown extensions and rich structures survive repeated parse/save cycles", async () => {
  const { MarkdownToState } = await bundle("../vendor/marktext-muya/src/state/markdownToState.ts");
  const { default: StateToMarkdown } = await bundle("../vendor/marktext-muya/src/state/stateToMarkdown.ts");
  const parser = new MarkdownToState({ footnote: true, math: true, frontMatter: true, isGitlabCompatibilityEnabled: true, trimUnnecessaryCodeBlockEmptyLines: false });
  const serializer = new StateToMarkdown({ listIndentation: 1 });
  const fixtures = [
    "# 中文标题 😀\n\n[TOC]\n\n## 重复\n\n## 重复\n",
    "==高亮 **加粗**== 和 `==code==`\n",
    "> [!WARNING]\n> 注意 ==重要== 内容\n",
    "$$\nx^2\\label{eq:one}\n$$\n\n公式 $\\eqref{eq:one}$。\n",
    "$$\n\\ce{H2O}\\tag{A}\\label{eq:water}\n$$\n",
    "```math\nx+y\n```\n",
    "| 姓名 | 内容 |\n| :--- | ---: |\n| 张三 | a\\|b |\n",
    "- [ ] 未完成\n- [x] 已完成\n",
    "- 第一层\n  - 第二层\n    - 第三层\n",
    "![截图](<文件.assets/截图 1.png>)\n\n[标题](其他.md#中文)\n",
    "<img src=\"assets/a.png\" width=\"400\" data-align=\"center\">\n",
    "注释[^one]\n\n[^one]: 脚注内容\n",
    "---\ntitle: 测试\ntypora-copy-images-to: doc.assets\n---\n\n正文\n",
    "```mermaid\ngraph TD\n  A --> B\n```\n",
    "```plantuml\nAlice -> Bob: hello\n```\n",
    "~~删除~~ H~2~O a^2^ <mark>HTML 标记</mark>\n",
  ];
  for (const markdown of fixtures) {
    const originalState = parser.generate(markdown);
    const once = serializer.generate(originalState);
    const twice = serializer.generate(parser.generate(once));
    assert.equal(twice, once, markdown);
    assert.deepEqual(parser.generate(twice), originalState, markdown);
  }
});

test("source cursor restoration resolves nested state paths without rebuilding the document", async () => {
  const { injectSentinels, resolveStateSentinelCursor } = await load("../vendor/marktext-muya/src/selection/offsetCursor.ts");
  const { MarkdownToState } = await bundle("../vendor/marktext-muya/src/state/markdownToState.ts");
  const parser = new MarkdownToState({ footnote: true, math: true, frontMatter: true });
  const markdown = "# 标题\n\n正文中文\n\n> 引用正文\n\n- 列表正文\n";
  const clean = parser.generate(markdown);
  for (const cursor of [
    { anchor: { line: 2, ch: 4 }, focus: { line: 2, ch: 1 } },
    { anchor: { line: 0, ch: 3 }, focus: { line: 4, ch: 4 } },
    { anchor: { line: 6, ch: 3 }, focus: { line: 6, ch: 3 } },
  ]) {
    const result = resolveStateSentinelCursor(parser.generate(injectSentinels(markdown, cursor)), clean);
    assert.ok(result);
    const lookup = (path) => path.reduce((node, key) => node[key], clean);
    assert.equal(typeof lookup(result.anchorPath), "string");
    assert.equal(typeof lookup(result.focusPath), "string");
    if (cursor.anchor.line === 2) {
      assert.equal(result.anchor.offset, 4);
      assert.equal(result.focus.offset, 1);
    }
  }
  const syntaxCursor = { anchor: { line: 0, ch: 0 }, focus: { line: 0, ch: 0 } };
  assert.equal(resolveStateSentinelCursor(parser.generate(injectSentinels(markdown, syntaxCursor)), clean), null);
  assert.deepEqual(clean, parser.generate(markdown));
});

test("a failed image asset copy removes the loading marker and keeps the original source", async () => {
  const { pasteImageSrc } = await bundle("../vendor/marktext-muya/src/clipboard/pasteImage.ts");
  const block = {
    text: "",
    getCursor: () => ({ start: { offset: 0 }, end: { offset: 0 } }),
    setCursor() {},
  };
  const clipboard = {
    selection: { getSelection: () => ({ anchor: { block } }) },
    muya: { options: { imageAction: async () => { throw new Error("磁盘已满"); } } },
  };
  await assert.rejects(pasteImageSrc(clipboard, "assets/photo.png"), /磁盘已满/);
  assert.equal(block.text, "![](assets/photo.png)");
  assert.doesNotMatch(block.text, /loading-/);
});

test("live outline disambiguates repeated heading anchors and removes highlight syntax", async () => {
  const { getTOC } = await bundle("../vendor/marktext-muya/src/state/getTOC.ts");
  const headings = ["==重复==", "重复", "重复-1"].map((text) => ({ blockName: "atx-heading", meta: { level: 1 }, children: { head: { text: `# ${text}` } } }));
  const toc = getTOC({ options: { superSubScript: true, footnote: true, highlight: true }, editor: { scrollPage: { children: { iterator: () => headings } } } });
  assert.deepEqual(toc.map(({ content, githubSlug }) => ({ content, githubSlug })), [
    { content: "重复", githubSlug: "重复" },
    { content: "重复", githubSlug: "重复-1" },
    { content: "重复-1", githubSlug: "重复-1-1" },
  ]);
});

test("serialized Muya history restores across tab disposal and keeps source edits undoable", async () => {
  const { default: History } = await bundle("../vendor/marktext-muya/src/history/index.ts");
  function create(markdown) {
    let state = [{ name: "paragraph", text: markdown }];
    const block = {};
    block.circular = block; // A DOM/block reference must never enter the snapshot.
    const selection = { anchor: { path: [0, "text"], offset: 2, block }, focus: { path: [0, "text"], offset: 2, block }, isCollapsed: true, isSelectionInSameBlock: true, direction: "forward", type: "text" };
    const muya = { eventCenter: { on() {} }, editor: { selection: { getSelection: () => selection }, jsonState: { getState: () => state }, rebuildContents: (op) => { state = json1.type.apply(state, op); } } };
    const history = new History(muya);
    return {
      history, text: () => state[0].text,
      edit: (text) => { const op = json1.replaceOp([0, "text"], state[0].text, text); history.recordRebuild(op, state, selection); state = json1.type.apply(state, op); },
    };
  }
  const original = create("输入前");
  original.edit("中文输入完成");
  const snapshot = JSON.parse(JSON.stringify(original.history.getHistory()));
  const restored = create(original.text());
  restored.history.setHistory(snapshot);
  restored.edit("源码模式修改");
  restored.history.undo();
  assert.equal(restored.text(), "中文输入完成");
  restored.history.undo();
  assert.equal(restored.text(), "输入前");
  restored.history.redo();
  assert.equal(restored.text(), "中文输入完成");
  restored.history.redo();
  assert.equal(restored.text(), "源码模式修改");
});
