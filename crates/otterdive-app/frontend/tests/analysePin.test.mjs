import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';
import { selectedResultLineIndices,appendPinnedResults } from '../src/pinnedSearchResult.ts';
const source=fs.readFileSync(new URL('../src/analysePanel.ts',import.meta.url),'utf8');const ast=ts.createSourceFile('analysePanel.ts',source,ts.ScriptTarget.Latest,true);let fn;
function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='pinResultSelection')fn=node;ts.forEachChild(node,visit);}visit(ast);assert.ok(fn);
const js=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('real Analyse multi-selection appends complete independent results into the shared collection',()=>{
 const lines=[0,1,2].map(i=>({sourceLine:90+i,text:`full\nresult ${i}`,sourceDocumentId:5,sourceDocumentTitle:'closed.txt',sourceDocumentPath:'/old/closed.txt',matchingPatternIds:[8],styledSegments:[{startByteInLine:0,endByteInLine:4,bold:true}]}));
 let pins=appendPinnedResults([],[{kind:'search',text:'search',sources:[{path:'/search.txt',fileName:'search.txt',line:1,column:1}]}]);
 const context={latestResult:{documentId:5,lines},selectedResultLineIndices,resultEditor:{getSelections:()=>[{startLineNumber:1,endLineNumber:5,endColumn:1},{startLineNumber:2,endLineNumber:2,endColumn:5}],getPosition:()=>({lineNumber:1})},host:{getDocuments:()=>[],pinResults:inputs=>{pins=appendPinnedResults(pins,inputs);}}};vm.createContext(context);vm.runInContext(js,context);
 context.pinResultSelection();assert.equal(pins.length,3);assert.equal(pins[1].text,'full\nresult 0');assert.equal(pins[2].sources[0].line,91);assert.equal(pins[1].sources[0].path,'/old/closed.txt');assert.equal(pins[1].analysis.styledSegments[0].bold,true);
 context.pinResultSelection();assert.equal(pins.length,3);lines[0].text='changed';lines[0].styledSegments[0].bold=false;assert.equal(pins[1].text,'full\nresult 0');assert.equal(pins[1].analysis.styledSegments[0].bold,true);
 assert.match(source,/data-analyse-role="pin-result"/);assert.match(source,/element\("pin-result"\)\.addEventListener\("click", pinResultSelection\)/);
});
