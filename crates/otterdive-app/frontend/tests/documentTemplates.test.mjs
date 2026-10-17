import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/documentTemplates.ts', import.meta.url), 'utf8');
const moduleSource = source.replace(/^import .*;\n/gm, '');
const js = ts.transpileModule(moduleSource, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { expandTemplateVariables, BUILTIN_DOCUMENT_TEMPLATES, templateDraft } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('template variables use one local timestamp and retain Markdown, whitespace and unknown variables', () => {
  const date = new Date(2026, 9, 18, 7, 5, 59);
  const text = '# {{title}}\r\n\r\n{{date}} {{time}}\n{{unknown}}\n  ```js\n  const x = 1;\n  ```\n';
  assert.equal(expandTemplateVariables(text, { title: '技术方案', date }), '# 技术方案\r\n\r\n2026-10-18 07:05\n{{unknown}}\n  ```js\n  const x = 1;\n  ```\n');
});

test('title replacement is literal and never recursively expands variables or evaluates markup', () => {
  const title = '<img src=x onerror=alert(1)> $& {{date}}';
  assert.equal(expandTemplateVariables('{{title}} / {{title}}', { title, date: new Date(2026, 0, 1) }), `${title} / ${title}`);
});

test('copying a built-in starts a new custom draft without changing the built-in', () => {
  const original = BUILTIN_DOCUMENT_TEMPLATES[0];
  const draft = templateDraft(original);
  assert.equal(draft.id, undefined);
  assert.equal(draft.title, `${original.title}（副本）`);
  assert.equal(draft.text, original.text);
  draft.text = 'changed';
  assert.notEqual(original.text, 'changed');
  assert.equal(BUILTIN_DOCUMENT_TEMPLATES.length, 3);
});

test('editing a custom template preserves its identity and raw content before use', () => {
  const original = { id: 'user-1', title: '摘录', text: '  {{title}}\r\n<script>not executed</script>\n', updatedAt: 1 };
  const draft = templateDraft(original);
  assert.deepEqual(draft, { id: 'user-1', title: '摘录', text: original.text });
  assert.equal(original.text.includes('{{title}}'), true);
});

test('built-in templates cover meeting notes, technical plans and reading notes with reusable variables', () => {
  assert.deepEqual(BUILTIN_DOCUMENT_TEMPLATES.map(item => item.title), ['会议记录', '技术方案', '读书笔记']);
  for (const item of BUILTIN_DOCUMENT_TEMPLATES) {
    assert.equal(item.builtin, true);
    assert.ok(item.text.includes('{{title}}'));
    assert.ok(item.text.includes('{{date}}'));
  }
});
