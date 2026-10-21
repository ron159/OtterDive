import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const context = vm.createContext({});
const js = ts.transpileModule(fs.readFileSync(new URL('../src/pinnedSearchResult.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/^export /gm, '');
vm.runInContext(js, context);
const row = (line, text = '完整\n结果') => ({ kind: 'search', text, sources: [{ path: '/a/test.txt', fileName: 'test.txt', line, column: 2 }] });
test('append independently, deduplicate, remove one without changing the others', () => {
 const first = context.appendPinnedResults([], [row(1), row(2)]);
 assert.equal(first.length, 2);
 assert.equal(context.appendPinnedResults(first, [row(1)]), first);
 const mixed = context.appendPinnedResults(first, [{ ...row(3), kind: 'analyse' }]);
 assert.equal(mixed.length, 3);
 const remaining = context.removePinnedResult(mixed, first[0].id);
 assert.equal(remaining.length, 2); assert.equal(remaining[0], first[1]);
 assert.equal(context.removePinnedResult(remaining, 'missing'), remaining);
});
test('snapshot owns complete multiline Analyse payload and source identity', () => {
 const input = { ...row(9), kind: 'analyse', analysis: { sourceLine: 9, text: '完整\n结果', matchingPatternIds: [8], styledSegments: [{ bold: true }], sourceDocumentId: 5 } };
 const [pin] = context.appendPinnedResults([], [input]);
 input.sources[0].path = '/renamed'; input.analysis.matchingPatternIds.push(99); input.analysis.styledSegments[0].bold = false;
 assert.equal(pin.text, '完整\n结果'); assert.equal(pin.sources[0].path, '/a/test.txt');
 assert.equal(pin.analysis.matchingPatternIds.length, 1); assert.equal(pin.analysis.styledSegments[0].bold, true);
 assert.equal(Object.isFrozen(pin.analysis.styledSegments[0]), true);
});
test('Monaco selection collects all ranges once and excludes an empty end line', () => {
 const ranges = [{startLineNumber: 2, endLineNumber: 5, endColumn: 1}, {startLineNumber: 3, endLineNumber: 6, endColumn: 3}];
 assert.deepEqual(Array.from(context.selectedResultLineIndices(ranges, 8, 1)), [1,2,3,4,5]);
 assert.deepEqual(Array.from(context.selectedResultLineIndices([], 8, 3)), [2]);
});

test('a multiline Analyse item is selected as a whole from any rendered line, with exclusive end and overlap deduplication',()=>{
 const spans=[2,3,1];
 const selectedResultLineIndices=(...args)=>Array.from(context.selectedResultLineIndices(...args));
 assert.deepEqual(selectedResultLineIndices([],3,2,spans),[0]);
 assert.deepEqual(selectedResultLineIndices([{startLineNumber:2,endLineNumber:4,endColumn:1},{startLineNumber:3,endLineNumber:5,endColumn:8}],3,1,spans),[0,1]);
 assert.deepEqual(selectedResultLineIndices([{startLineNumber:5,endLineNumber:6,endColumn:1}],3,1,spans),[1]);
});
