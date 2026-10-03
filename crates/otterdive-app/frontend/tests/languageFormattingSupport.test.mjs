import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const languageSupport = await loadTypeScriptModule("../src/languageSupport.ts");
const formatterSupport = await loadTypeScriptModule("../src/formatterSupport.ts");
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

const registry = [
  { id: "custom", extensions: [".custom"], filenames: ["CUSTOMFILE"] },
];

test("resolves common source and configuration file extensions", () => {
  assert.equal(languageSupport.languageFromFilePath("src/main.tsx", registry), "typescript");
  assert.equal(languageSupport.languageFromFilePath("C:\\work\\tool.py", registry), "python");
  assert.equal(languageSupport.languageFromFilePath("compose.yml", registry), "yaml");
  assert.equal(languageSupport.languageFromFilePath("schema.graphql", registry), "graphql");
  assert.equal(languageSupport.languageFromFilePath("header.hpp", registry), "cpp");
});

test("resolves extensionless and Monaco-registered file names", () => {
  assert.equal(languageSupport.languageFromFilePath("services/api/Dockerfile", registry), "dockerfile");
  assert.equal(languageSupport.languageFromFilePath("Makefile", registry), "shell");
  assert.equal(languageSupport.languageFromFilePath("CUSTOMFILE", registry), "custom");
  assert.equal(languageSupport.languageFromFilePath("sample.custom", registry), "custom");
  assert.equal(languageSupport.languageFromFilePath("unknown.extension", registry), "plaintext");
});

test("suggests common formats from unknown or missing extensions", () => {
  const samples = [
    ['{"name":"OtterDive","items":[1,2]}', "json"],
    ['\uFEFF // settings\n{ "url": "https://example.com", "enabled": true, }', "json"],
    ['<!DOCTYPE html><html><body><h1>Hello</h1></body></html>', "html"],
    ['<?xml version="1.0"?><root><item id="1"/></root>', "xml"],
    ['<settings><enabled>true</enabled></settings>', "xml"],
    ['name: OtterDive\noptions:\n  enabled: true', "yaml"],
    ['[server]\nport = 8080\nenabled = true', "toml"],
    ['[server]\nhost=localhost\nmode=development', "ini"],
    ['SELECT id, name FROM users WHERE active = 1;', "sql"],
    ['export const greet = (name) => { return `Hi ${name}`; };', "javascript"],
    ['interface User { name: string; }\nconst user: User = { name: "Otter" };', "typescript"],
    ['def greet(name):\n    return "Hi " + name', "python"],
    ['#!/usr/bin/env bash\necho "hello"', "shell"],
    ['FROM alpine:3\nRUN echo hello', "dockerfile"],
    ['# Heading\n\n- first\n- second', "markdown"],
    ['body { color: red; margin: 0; }', "css"],
  ];
  for (const [source, expected] of samples) {
    for (const path of ["sample.unknown", "sample", "C:\\work\\sample.backup"]) {
      assert.equal(languageSupport.suggestLanguageFromContent(path, source, registry), expected, `${path}: ${source}`);
    }
  }
});

test("leaves known extensions, ambiguous text, malformed JSON and binary data alone", () => {
  for (const path of ["notes.txt", "app.log", "data.csv", "app.json", "sample.custom", "Dockerfile", ".env"]) {
    assert.equal(languageSupport.suggestLanguageFromContent(path, '{"key":1}', registry), null, path);
  }
  for (const source of ["", "hello world", "123", "true", '{"broken":', 'Meeting: tomorrow',
    'https://example.com\nTime: 12:30', '[not a section', '# Just a heading', '\0{"key":1}',
    '{"key":"' + 'a'.repeat(300_000) + '"}']) {
    assert.equal(languageSupport.suggestLanguageFromContent("sample.unknown", source, registry), null, source.slice(0, 80));
  }
});

function detectionHarness(options = {}) {
  const doc = { id: 1, path: '/sample.unknown', title: 'sample.unknown', language: 'plaintext', text: '{"key":1}', version: 1, ...options.doc };
  const calls = { prompts: [], formatted: [], scheduled: 0 };
  const context = {
    activeDocument: () => doc, documentText: doc => doc.text, documentValueLength: doc => doc.text.length,
    documentVersion: doc => doc.version,
    state: { activeId: 1, documents: [doc], restoring: false },
    busyDepth: 0, promptingDetectedLanguage: false, confirmResolver: null, unsavedResolver: null, textInputResolver: null,
    monaco: { languages: { getLanguages: () => registry } },
    suggestLanguageFromContent: languageSupport.suggestLanguageFromContent,
    supportsDprintLanguage: formatterSupport.supportsDprintLanguage,
    editor: { focus() {} },
    languageLabel: language => language,
    scheduleLanguageDetection: () => { calls.scheduled++; },
    askConfirm: async prompt => { calls.prompts.push(prompt); await options.onPrompt?.(context, doc); return options.accept ?? false; },
    setLanguage: language => { doc.language = language; doc.languageOverride = language; },
    formatDocument: async doc => { calls.formatted.push(doc.id); },
  };
  const ast = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'offerDetectedLanguage');
  assert.ok(fn, 'content detection must be wired into the document flow');
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { doc, calls, context, offer: () => context.offerDetectedLanguage() };
}

test("accepting detection enables the selected language and formats only after consent", async () => {
  const h = detectionHarness({ accept: true });
  assert.equal(h.calls.formatted.length, 0);
  await h.offer();
  assert.equal(h.doc.language, 'json');
  assert.equal(h.doc.languageOverride, 'json');
  assert.deepEqual(h.calls.formatted, [1]);
  await h.offer();
  assert.equal(h.calls.prompts.length, 1);
});

test("declining keeps original content and plain text without prompting again", async () => {
  const h = detectionHarness();
  await h.offer();
  await h.offer();
  assert.equal(h.doc.text, '{"key":1}');
  assert.equal(h.doc.languageOverride, 'plaintext');
  assert.equal(h.calls.formatted.length, 0);
  assert.equal(h.calls.prompts.length, 1);
});

test("read-only and highlight-only formats do not promise or perform formatting", async () => {
  for (const doc of [{ readOnly: true }, { text: '<root><item/></root>' }]) {
    const h = detectionHarness({ accept: true, doc });
    await h.offer();
    assert.equal(h.calls.formatted.length, 0);
    assert.equal(h.calls.prompts[0].okLabel, '是，启用高亮');
    assert.notEqual(h.doc.language, 'plaintext');
  }
});

test("restoration and existing dialogs defer detection; user language and large files skip it", async () => {
  for (const defer of [ctx => { ctx.state.restoring = true; }, ctx => { ctx.confirmResolver = () => {}; }]) {
    const h = detectionHarness();
    defer(h.context);
    await h.offer();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.doc.languageDetectionChecked, undefined);
    assert.equal(h.calls.scheduled, 1);
  }
  for (const doc of [{ languageOverride: 'plaintext' }, { largeFile: true }, { text: 'x'.repeat(300_000) }]) {
    const h = detectionHarness({ doc });
    await h.offer();
    assert.equal(h.calls.prompts.length, 0);
  }
});

test("stale confirmation cannot format a switched, edited, renamed or closed document", async () => {
  for (const onPrompt of [ctx => { ctx.state.activeId = 2; }, (ctx, doc) => { doc.version++; },
    (ctx, doc) => { doc.path = '/different'; }, ctx => { ctx.state.documents = []; },
    (ctx, doc) => { doc.languageOverride = 'python'; }]) {
    const h = detectionHarness({ accept: true, onPrompt });
    await h.offer();
    assert.equal(h.calls.formatted.length, 0);
    assert.equal(h.doc.language, 'plaintext');
  }
});

test("routes supported languages to a matching formatter file name", () => {
  assert.equal(formatterSupport.supportsDprintLanguage("typescript"), true);
  assert.equal(formatterSupport.supportsDprintLanguage("rust"), false);
  assert.equal(formatterSupport.formatterFilePath("typescript", "/tmp/component.tsx"), "component.tsx");
  assert.equal(formatterSupport.formatterFilePath("typescript", null), "untitled.ts");
  assert.equal(formatterSupport.formatterFilePath("json", "/tmp/Untitled-1.txt"), "untitled.json");
  assert.equal(formatterSupport.formatterFilePath("dockerfile", "/tmp/Containerfile"), "Dockerfile");
});

test("keeps a manually selected language ahead of the file extension", () => {
  assert.equal(languageSupport.languageWithOverride("plaintext", "json"), "json");
  assert.equal(languageSupport.languageWithOverride("json", undefined), "json");
  assert.equal(languageSupport.languageWithOverride(undefined, undefined), "plaintext");
});

test("formats with the Monaco-selected language and surfaces failures", () => {
  assert.match(mainSource, /doc\.languageOverride = language;/);
  assert.match(mainSource, /const language = (?:ensureDocumentModel\(doc\)|model)\.getLanguageId\(\) \|\| doc\.language \|\| "plaintext";/);
  assert.match(mainSource, /title: "格式化失败",[\s\S]*subtitle: `已按 \$\{label\} 语言处理`/);
});

test("preserves whether the source ended with a newline", () => {
  assert.equal(formatterSupport.preserveTrailingNewline("const value = 1;\n", "const value=1"), "const value = 1;");
  assert.equal(formatterSupport.preserveTrailingNewline("const value = 1;", "const value=1\r\n"), "const value = 1;\r\n");
  assert.equal(formatterSupport.preserveTrailingNewline("key = 1\n\n", "key=1\n"), "key = 1\n");
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
