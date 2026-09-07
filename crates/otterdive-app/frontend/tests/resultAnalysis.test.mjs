import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/resultAnalysis.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { analyseResults, exportResultRows } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const rows = ['ERROR id=a', 'ERROR id=a', 'INFO id=b'].map((text, i) => ({ path: '日志.txt', line: i+1, column: 2, text }));
test('filters and excludes while preserving original locations', () => {
  const filtered = analyseResults(rows, { action: 'include', query: 'error', regex: false, matchCase: false });
  assert.deepEqual(filtered.map(r => r.line), [1,2]);
  assert.deepEqual(analyseResults(filtered, { action: 'exclude', query: 'id=a', regex: false, matchCase: true }), []);
});
test('captures and deduplicates with source navigation intact', () => {
  const captured = analyseResults(rows, { action: 'extract', query: 'id=(?<id>\\w+)', regex: true, matchCase: true });
  assert.equal(captured[0].text, 'a');
  assert.equal(captured[0].path, '日志.txt');
  assert.deepEqual(captured[0].fields, { id: 'a' });
  assert.deepEqual(analyseResults(captured, { action: 'dedupe', query: '', regex: false, matchCase: true }).map(r => r.line), [1,3]);
});
test('invalid regex does not silently produce empty results', () => {
  assert.throws(() => analyseResults(rows, { action: 'include', query: '[', regex: true, matchCase: true }));
});
test('CSV quotes delimiters and prevents spreadsheet formula execution', () => {
  const csv = exportResultRows([{ path: '=bad', line: 2, column: 1, text: 'a,"b"\nc' }], 'csv');
  assert.ok(csv.includes("'=bad"));
  assert.ok(csv.includes('"a,""b""\nc"'));
});
