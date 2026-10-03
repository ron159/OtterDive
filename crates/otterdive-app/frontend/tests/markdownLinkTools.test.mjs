import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function code(file) {
  const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/^export /gm, "");
}
const production = code("markdownPaths.ts") + code("markdownLinkTools.ts");
function setup(files, targets) {
  const calls = [];
  class DOMParser {
    parseFromString(source) {
      const fixture = JSON.parse(source);
      return { querySelectorAll: selector => selector === "a[href]"
        ? (fixture.links ?? []).map(link => ({ getAttribute: () => link.href, textContent: link.label || link.href }))
        : (fixture.ids ?? []).map(id => ({ id })) };
    }
  }
  const context = vm.createContext({
    DOMParser, URL,
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "file_revisions") return args.paths.map(path => ({ path, revision: files[path] ?? "missing", error: null }));
      if (command === "read_file_chunk") return { text: JSON.stringify(targets[args.request.path]), hasMore: false, warning: null };
      throw new Error(command);
    },
  });
  vm.runInContext(production, context);
  return { check: fixture => context.checkMarkdownLinks({ text: JSON.stringify(fixture), path: "/notes/current.md", renderHtml: text => text }), calls };
}

test("local link checking reports missing files and anchors while leaving external URLs alone", async () => {
  const { check, calls } = setup({ "/notes/target.md": "r1" }, { "/notes/target.md": { ids: ["found"] } });
  const issues = await check({ ids: ["here", "fn-1"], links: [
    { href: "#here" }, { href: "#fn-1" }, { href: "#missing" }, { href: "missing.md" },
    { href: "target.md#found" }, { href: "target.md#absent" }, { href: "https://example.com/#x" },
  ] });
  assert.deepEqual(Array.from(issues, issue => issue.href), ["#missing", "missing.md", "target.md#absent"]);
  assert.equal(issues[1].reason, "目标文件不存在");
  assert.equal(calls.filter(call => call.command === "read_file_chunk").length, 1);
  assert.deepEqual(Array.from(calls[0].args.paths), ["/notes/missing.md", "/notes/target.md"]);
});

test("percent-encoded Unicode anchors are checked against actual renderer IDs", async () => {
  const { check } = setup({ "/notes/中文 空格.md": "r1" }, { "/notes/中文 空格.md": { ids: ["标题", "标题-1"] } });
  const issues = await check({ links: [{ href: "%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.md#%E6%A0%87%E9%A2%98-1" }] });
  assert.equal(issues.length, 0);
});

test("remote-only documents require no filesystem or network calls", async () => {
  const { check, calls } = setup({}, {});
  const issues = await check({ links: [{ href: "https://example.com" }, { href: "mailto:author@example.com" }, { href: "//example.com/page" }] });
  assert.equal(issues.length, 0); assert.equal(calls.length, 0);
});


test("explicit current-file links use unsaved current headings instead of stale disk text", async () => {
  const { check, calls } = setup({ "/notes/current.md": "r1" }, { "/notes/current.md": { ids: [] } });
  const issues = await check({ ids: ["unsaved-heading"], links: [{ href: "current.md#unsaved-heading" }] });
  assert.equal(issues.length, 0);
  assert.equal(calls.filter(call => call.command === "read_file_chunk").length, 0);
});
