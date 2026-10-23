import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/markdownEditor.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("markdownEditor.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["expandRegexReplacement", "regexNamedGroupsAt"]);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(functions.map(node => node.getText(ast)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);

const output = await build({
  entryPoints: [fileURLToPath(new URL("../vendor/marktext-muya/src/utils/search.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { matchString } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);

function replaceMatches(text, query, replacement, wholeWord = false) {
  const options = { matchCase: true, regex: true, wholeWord };
  const matches = matchString(text, query, { isCaseSensitive: true, isRegexp: true, isWholeWord: wholeWord });
  assert.ok(matches.length, "the actual Markdown search engine must find the fixture");
  let end = 0;
  let result = "";
  for (const match of matches) {
    const found = { ...match, start: match.index, end: match.index + match.match.length };
    result += text.slice(end, found.start) + context.expandRegexReplacement(replacement, found, text, { value: query, options });
    end = found.end;
  }
  return result + text.slice(end);
}

test("Markdown named replacements preserve complete emoji captures from Unicode search", () => {
  assert.equal(replaceMatches("😀", "(?<character>.)", "[$<character>]"), "[😀]");
});

test("Markdown named replacements use Unicode property escapes supported by the matcher", () => {
  assert.equal(replaceMatches("中文 English", "(?<word>\\p{L}+)", "$<word>!"), "中文! English!");
});

test("whole-word replacement keeps the matcher's Unicode boundaries for named captures", () => {
  assert.equal(replaceMatches("中文 中文字", "(?<word>中文)", "[$<word>]", true), "[中文] 中文字");
});

test("legacy expressions retain the matcher's non-Unicode fallback", () => {
  assert.equal(replaceMatches("a-b", "(?<dash>\\-)", "[$<dash>]"), "a[-]b");
});
