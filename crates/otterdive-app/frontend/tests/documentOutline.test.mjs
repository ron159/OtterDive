import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/documentOutline.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { documentOutlineLayout, restoreOutlinePreferences } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('wide canvas centers the document and outline together', () => {
  const { outlineWidth, inset } = documentOutlineLayout(1800, '1024px', true, false);
  assert.equal(1800 - inset * 2 - outlineWidth - 24, 1024);
  assert.ok(outlineWidth < 224);
});

test('narrow, full-width and split editors retain available page space', () => {
  for (const args of [[600, '760px', true, false], [1800, '100%', true, false], [1800, '760px', true, true]]) {
    const { outlineWidth, inset } = documentOutlineLayout(...args);
    assert.equal(inset, 0);
    assert.ok(args[0] - outlineWidth - 24 >= 440);
  }
  assert.deepEqual(documentOutlineLayout(1200, '760px', false, false), { outlineWidth: 0, inset: 0 });
});

test('migration preserves outline visibility and placement', () => {
  assert.deepEqual(restoreOutlinePreferences({ rightTool: 'outline', rightSidebarOpen: true, outlinePosition: 'left', outlineDisplayMode: 'always' }),
    { outlineOpen: true, outlinePosition: 'left', outlineDisplayMode: 'always' });
  assert.equal(restoreOutlinePreferences({ rightTool: 'outline', rightSidebarOpen: false }).outlineOpen, false);
  assert.equal(restoreOutlinePreferences({ outlineOpen: false, rightTool: 'analyse' }).outlineOpen, false);
  assert.deepEqual(restoreOutlinePreferences({ outlinePosition: 'invalid', outlineDisplayMode: 'invalid' }),
    { outlineOpen: true, outlinePosition: 'right', outlineDisplayMode: 'hover' });
});
