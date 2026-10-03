import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

async function load(name) {
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const paths = await load('markdownPaths');
const { writingStats, markdownProse } = await load('writingStats');
const { normalizeWorkbenchPreferences, markdownExtensionPreferences, spellcheckLanguageSuggestions } = await load('workbenchPreferences');
const navigation = await load('markdownNavigation');

test('resource paths preserve platform roots, spaces and parent traversal', () => {
  assert.equal(paths.resolveMarkdownResource('../图片/a%20b.png', '/Users/ron/docs/page.md'), '/Users/ron/图片/a b.png');
  assert.equal(paths.resolveMarkdownResource('/Users/图/a.png', '/Users/ron/page.md'), '/Users/图/a.png');
  assert.equal(paths.resolveMarkdownResource('file:///Users/图/a%20b.png'), '/Users/图/a b.png');
  assert.equal(paths.resolveMarkdownResource('file:///C:/a%20b/image.png'), 'C:\\a b\\image.png');
  assert.equal(paths.resolveMarkdownResource('../img/a.png', 'C:\\docs\\sub\\a.md'), 'C:\\docs\\img\\a.png');
  assert.equal(paths.resolveMarkdownResource('file://server/share/a.png'), '\\\\server\\share\\a.png');
  assert.equal(paths.resolveMarkdownResource('javascript:alert(1)', '/tmp/a.md'), '');
  assert.equal(paths.resolveMarkdownResource('img/a.png', null, '/tmp/project'), '/tmp/project/img/a.png');
  assert.equal(paths.resolveMarkdownResource('img/a.png'), '');
});

test('relative links respect POSIX case, Windows volumes and decoded heading anchors', () => {
  assert.equal(paths.relativeMarkdownResource('/Users/ron/Docs', '/Users/ron/docs/a.png'), '../docs/a.png');
  assert.equal(paths.relativeMarkdownResource('C:\\Docs', 'c:\\docs\\a.png'), 'a.png');
  assert.equal(paths.relativeMarkdownResource('C:\\Docs', 'D:\\a.png'), 'D:/a.png');
  assert.deepEqual(paths.splitMarkdownLink('readme.md#%E6%A0%87%E9%A2%98'), { path: 'readme.md', anchor: '标题' });
});

test('writing statistics omit markup metadata and code while counting Unicode graphemes', () => {
  const source = '---\ntitle: hidden\n---\n# 中文\nHello **world** [文档](http://example.com)\n```js\nhidden code\n```\n';
  const stats = writingStats(source, true);
  assert.equal(stats.chinese, 4);
  assert.equal(stats.words, 2);
  assert.equal(stats.readingMinutes, 1);
  assert.equal(writingStats('👨‍👩‍👧‍👦 e\u0301').characters, 2);
  assert.equal(writingStats('').readingMinutes, 0);
  assert.equal(markdownProse('```js\ncode\n```', true).trim(), 'code');
});

test('preference migration clamps malformed data and leaves remote rendering disabled', () => {
  const p = normalizeWorkbenchPreferences({ retentionDays: -4, historyEntries: Infinity, lineHeight: 12, plantumlServer: 'javascript:foo', focusMode: 'yes' });
  assert.equal(p.retentionDays, 1);
  assert.equal(p.historyEntries, 50);
  assert.equal(p.lineHeight, 2.5);
  assert.equal(p.plantumlServer, '');
  assert.equal(p.focusMode, false);
  assert.equal(normalizeWorkbenchPreferences({ autoSaveMode: 'off', recoveryEnabled: false }).recoveryEnabled, false);
});

test('Markdown extension preferences default on and individually persist false', () => {
  const defaults = markdownExtensionPreferences(normalizeWorkbenchPreferences({}));
  assert.deepEqual(defaults, { footnote: true, math: true, superSubScript: true, frontMatter: true, highlight: true, alerts: true, toc: true });
  const migrated = normalizeWorkbenchPreferences({ markdownMath: false, markdownToc: false, markdownAlerts: 'false' });
  assert.equal(markdownExtensionPreferences(migrated).math, false);
  assert.equal(markdownExtensionPreferences(migrated).toc, false);
  assert.equal(markdownExtensionPreferences(migrated).alerts, true);
});

test('spellcheck accepts custom language tags and suggests system preferences first', () => {
  assert.equal(normalizeWorkbenchPreferences({ spellcheckLanguage: ' en-us ' }).spellcheckLanguage, 'en-US');
  assert.equal(normalizeWorkbenchPreferences({ spellcheckLanguage: 'ru-RU' }).spellcheckLanguage, 'ru-RU');
  assert.equal(normalizeWorkbenchPreferences({ spellcheckLanguage: 'invalid language' }).spellcheckLanguage, '');
  assert.equal(normalizeWorkbenchPreferences({ spellcheckLanguage: '' }).spellcheckLanguage, '');
  const suggestions = spellcheckLanguageSuggestions(['nl-NL', 'en-us', 'nl-NL']);
  assert.deepEqual(suggestions.slice(0, 2), ['nl-NL', 'en-US']);
  assert.equal(suggestions.filter((value) => value === 'en-US').length, 1);
});

test('mode cursor handoff keeps backward selections and zero-based Unicode columns', () => {
  const selection = { selectionStartLineNumber: 8, selectionStartColumn: 12, positionLineNumber: 3, positionColumn: 2 };
  const cursor = navigation.sourceSelectionToMarkdownCursor(selection);
  assert.deepEqual(cursor, { anchor: { line: 7, ch: 11 }, focus: { line: 2, ch: 1 } });
  assert.deepEqual(navigation.markdownCursorToSourceSelection(cursor), selection);
  assert.equal(navigation.markdownCursorToSourceSelection({ anchor: null, focus: null }), null);
});

test('mode scrolling retains the chapter fraction when rendered section heights differ', () => {
  const anchor = navigation.captureMarkdownScrollAnchor(300, 1000, [0, 200, 600]);
  assert.equal(anchor.headingIndex, 1);
  assert.equal(navigation.restoreMarkdownScrollAnchor(anchor, 2000, [0, 400, 1200]), 600);
  assert.equal(navigation.restoreMarkdownScrollAnchor(anchor, 2000, []), 600);
  const intro = navigation.captureMarkdownScrollAnchor(50, 1000, [100, 500]);
  assert.equal(navigation.restoreMarkdownScrollAnchor(intro, 2000, [200, 1000]), 100);
  assert.equal(navigation.restoreMarkdownScrollAnchor(anchor, 0, [0]), 0);
});
