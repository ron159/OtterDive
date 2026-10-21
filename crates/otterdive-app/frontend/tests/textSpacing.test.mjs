import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = await build({
  entryPoints: [fileURLToPath(new URL("../src/textSpacing.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { optimizeTextSpacing } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);

test("spaces Chinese next to English and numbers without splitting ASCII words", () => {
  for (const [input, expected] of [
    ["中文English123文字", "中文 English123 文字"],
    ["版本v2更新，价格100元", "版本 v2 更新，价格 100 元"],
    ["Hello中文和AI技术2026版", "Hello 中文和 AI 技术 2026 版"],
    ["GitHub v2.0 / 中文标点，。！？123.45", "GitHub v2.0 / 中文标点，。！？123.45"],
  ]) assert.equal(optimizeTextSpacing(input), expected);
});

test("preserves blank lines, CRLF, indentation, existing whitespace and the final newline", () => {
  const input = "\t中文English  中文123\r\n\r\n  缩进ABC\t已有 空格  \r\n";
  const expected = "\t中文 English  中文 123\r\n\r\n  缩进 ABC\t已有 空格  \r\n";
  assert.equal(optimizeTextSpacing(input), expected);
});

test("leaves empty, already spaced and single-script text unchanged", () => {
  for (const text of ["", "\r\n\t ", "中文 English123 文字", "English123", "纯中文", "中文，English；123。"])
    assert.equal(optimizeTextSpacing(text), text);
});

test("plain text treats Markdown punctuation as text", () => {
  assert.equal(optimizeTextSpacing("`中文English`\n# 标题123\n    代码English"), "`中文 English`\n# 标题 123\n    代码 English");
});

test("optimizes Markdown headings, lists, quotes and table cells without reserializing syntax", () => {
  const input = "# 标题English\r\n\r\n- [ ] 待办123\r\n  - 子项English\r\n> 引用ABC\r\n\r\n| 列English | 数字123 |\r\n| :--- | ---: |\r\n| 中文API | 保留\\|符号123 |\r\n";
  const expected = "# 标题 English\r\n\r\n- [ ] 待办 123\r\n  - 子项 English\r\n> 引用 ABC\r\n\r\n| 列 English | 数字 123 |\r\n| :--- | ---: |\r\n| 中文 API | 保留\\|符号 123 |\r\n";
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("protects inline code with single and multiple backtick delimiters", () => {
  const input = "正文English 和 `中文English123`，``中文`English123``，尾部123文字";
  assert.equal(optimizeTextSpacing(input, true), "正文 English 和 `中文English123`，``中文`English123``，尾部 123 文字");
});

test("protects fenced code and respects longer fences containing shorter backtick lines", () => {
  const input = "# 标题English\n\n````md\n中文English123\n```\n仍然English123\n````\n\n正文123\n";
  const expected = "# 标题 English\n\n````md\n中文English123\n```\n仍然English123\n````\n\n正文 123\n";
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("protects tilde fences with CRLF while optimizing following prose", () => {
  const input = "~~~python\r\n变量English123 = 1\r\n~~~\r\n\r\n说明English123\r\n";
  assert.equal(optimizeTextSpacing(input, true), "~~~python\r\n变量English123 = 1\r\n~~~\r\n\r\n说明 English123\r\n");
});

test("protects indented code without changing surrounding paragraph spacing", () => {
  const input = "普通English\n\n    代码English123\n\t代码English123\n\n正文English";
  assert.equal(optimizeTextSpacing(input, true), "普通 English\n\n    代码English123\n\t代码English123\n\n正文 English");
});

test("optimizes link labels and image alt text while preserving destinations and titles", () => {
  const input = '查看[中文English](https://example.com/路径English123 "标题English")和![图片English](assets/图片English123.png)，结束123。';
  const expected = '查看[中文 English](https://example.com/路径English123 "标题English")和![图片 English](assets/图片English123.png)，结束 123。';
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("preserves angle-bracket and balanced-parenthesis link destinations and autolinks", () => {
  const input = "[说明English](<assets/中文English123 (copy).md>) [说明English](assets/中文English123(foo).md) <https://example.com/中文English123>";
  const expected = "[说明 English](<assets/中文English123 (copy).md>) [说明 English](assets/中文English123(foo).md) <https://example.com/中文English123>";
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("preserves reference identifiers and definitions while optimizing explicit display labels", () => {
  const input = '[正文English][文档English]\n\n[文档English]: docs/中文English123.md "标题English123"\n';
  const expected = '[正文 English][文档English]\n\n[文档English]: docs/中文English123.md "标题English123"\n';
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("preserves shortcut and collapsed reference labels so their identifiers still resolve", () => {
  const input = "[文档English] 和 [图片English][]\n\n[文档English]: 中文English.md\n[图片English]: 图片English.png\n\n正文English";
  assert.equal(optimizeTextSpacing(input, true), "[文档English] 和 [图片English][]\n\n[文档English]: 中文English.md\n[图片English]: 图片English.png\n\n正文 English");
});

test("protects front matter metadata including its CRLF and delimiter spelling", () => {
  const input = "---\r\ntitle: 中文English123\r\npath: assets/图片English.png\r\n---\r\n\r\n# 正文English\r\n";
  const expected = "---\r\ntitle: 中文English123\r\npath: assets/图片English.png\r\n---\r\n\r\n# 正文 English\r\n";
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("protects raw HTML elements, attributes and comments while optimizing surrounding prose", () => {
  const input = '普通English <span title="中文English123">内部English</span> 尾部ABC\n\n<!-- 注释English123 -->\n\n<div>\n内部English123\n</div>\n\n正文English';
  const expected = '普通 English <span title="中文English123">内部English</span> 尾部 ABC\n\n<!-- 注释English123 -->\n\n<div>\n内部English123\n</div>\n\n正文 English';
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("protects inline and display math using dollar and TeX delimiters", () => {
  const input = "公式 $中文English123 + 1$ 与 \\(中文English123\\)，正文English\n\n$$\n中文English123 = 1\n$$\n\n\\[\n中文English123 = 2\n\\]\n\n末尾123";
  const expected = "公式 $中文English123 + 1$ 与 \\(中文English123\\)，正文 English\n\n$$\n中文English123 = 1\n$$\n\n\\[\n中文English123 = 2\n\\]\n\n末尾 123";
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("an unclosed code fence protects the remaining source", () => {
  const input = "说明English\n\n```js\n变量English123\n仍在代码English";
  assert.equal(optimizeTextSpacing(input, true), "说明 English\n\n```js\n变量English123\n仍在代码English");
});

test("protects fences inside a list followed by a quote", () => {
  const input = "- > ~~~js\n  > 代码English123\n  > ~~~\n\n正文English";
  assert.equal(optimizeTextSpacing(input, true), "- > ~~~js\n  > 代码English123\n  > ~~~\n\n正文 English");
});

test("protects nested HTML while thematic breaks do not hide ordinary prose", () => {
  const input = "<div><div>内部English</div>外层English</div>\n\n正文English\n\n---\n\n中间English\n\n---\n";
  const expected = "<div><div>内部English</div>外层English</div>\n\n正文 English\n\n---\n\n中间 English\n\n---\n";
  assert.equal(optimizeTextSpacing(input, true), expected);
});

test("repeated optimization is idempotent in plain text and Markdown", () => {
  for (const [input, markdown] of [
    ["中文English123文字\r\n  版本v2更新", false],
    ["# 中文English\n\n正文123 与 `代码English`\n\n[文档English](目录English/file123.md)", true],
  ]) {
    const once = optimizeTextSpacing(input, markdown);
    assert.equal(optimizeTextSpacing(once, markdown), once);
  }
});

test("link identifiers and destinations containing math syntax remain intact in containers", () => {
  for (const text of [
    "> [引用English]: docs/中文English.md\n>\n> [引用English]",
    "[正文English][引用English$X$]\n\n[引用English$X$]: 目标English.md",
    "[正文English](docs/中文English$X$.md)",
  ]) {
    const result = optimizeTextSpacing(text, true);
    assert.equal(result.replace("正文 English", "正文English"), text);
  }
  assert.equal(optimizeTextSpacing("示例 `<tag>` 后续正文English", true), "示例 `<tag>` 后续正文 English");
});
