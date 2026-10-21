import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const ast = ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
const names = new Set(['searchResultPinButton','searchResultSnapshot','handleSearchResultPin','addPinnedResults','renderPinnedSearchResult','unpinSearchResult','nativeResultsAvailable','syncBottomResults','openBottomResults','closeBottomResults','clearSearchResults','resetSearchResults','closeDocument','bottomResultsMaxHeight']);
const js = ts.transpileModule(ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.has(n.name?.text)).map(n=>n.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const moduleJs = ts.transpileModule(fs.readFileSync(new URL('../src/pinnedSearchResult.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace(/^export /gm,'');
const noop=()=>{};
function setup(){
 let focused; const nodes = new Map();
 class Element {
  constructor(tag){this.tagName=tag;}
  children=[];dataset={};textContent='';title='';scrollTop=600;scrollLeft=240;attributes={};
  classes=new Set();classList={add:k=>this.classes.add(k),remove:k=>this.classes.delete(k),contains:k=>this.classes.has(k),toggle:(k,on)=>{if(on??!this.classes.has(k))this.classes.add(k);else this.classes.delete(k);}};
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  remove(){this.parent.children=this.parent.children.filter(n=>n!==this);}
  setAttribute(k,v){this.attributes[k]=v;}
  focus(){focused=this;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='[data-unpin-id]'&&child.dataset.unpinId?[child]:[]),...child.querySelectorAll(selector)]);}
 }
 const node=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
 const match={line:23,column:7,lineText:'<script>snapshot & text</script>'};
 const report={total:1,hits:[{path:'/one/same.txt',fileName:'same.txt',matches:[match]}]};
 const state={pinnedResults:[],documents:[{id:1,path:'/one/same.txt'},{id:2,path:'/two/same.txt'}],activeId:2,results:report,searchResultHistory:[],replacePreview:null,workspaceSearchStatus:'idle'};
 const context={state,analysedRows:null,activeBottomResultTool:'search',analyseResultsAvailable:true,$:node,document:{createElement:tag=>new Element(tag)},iconSvg:()=>'<svg></svg>',fileNameFromPath:p=>p.split('/').pop(),workspaceSearchIsBusy:()=>false,requestEditorLayout:noop,setBottomResultsHeight:noop,MIN_BOTTOM_RESULTS_HEIGHT:160,window:{requestAnimationFrame:noop,innerWidth:1024,innerHeight:640},analysePanel:null,focusActiveEditor:()=>{focused='editor';},resetResultAnalysis:()=>{context.analysedRows=null;},renderSearchSidebarResults:noop,searchDecorations:null,activeSearchDecoration:null,markdownEditor:null,setCurrentFindError:noop,renderCurrentFindCount:noop,log:noop,confirmDocumentCanClose:async()=>true,rememberMarkdownLocation:noop,rememberClosedDocument:noop,discardRecovery:noop,writingStatsCache:new Map(),pagedDocuments:new Map(),closeSideEditorFor:noop,cancelAutoSave:noop,disposeMarkdownEditor:noop,markdownSessions:new Map(),cancelDocumentSizeUpdate:noop,activateDocument:id=>{state.activeId=id;},renderAll:noop,scheduleSessionSave:noop};
 vm.createContext(context);vm.runInContext(moduleJs,context);vm.runInContext(js,context);
 const pin=dataset=>context.handleSearchResultPin({target:{closest:()=>({dataset})},preventDefault:noop,stopPropagation:noop});
 return {context,state,report,match,node,pin,focused:()=>focused};
}
test('multiple rows append, repeated Pin deduplicates, and snapshots cannot change with their source',()=>{
 const h=setup();h.pin({pinResultIndex:'0'});const first=h.state.pinnedResults[0];
 h.pin({pinResultIndex:'0'});assert.equal(h.state.pinnedResults.length,1);
 h.match.line=80;h.match.lineText='second result';h.pin({pinResultIndex:'0'});
 assert.equal(h.state.pinnedResults.length,2);assert.equal(first.text,'<script>snapshot & text</script>');
 assert.equal(first.sources[0].path,'/one/same.txt');assert.equal(h.state.activeId,2);assert.equal(Object.isFrozen(first.sources[0]),true);
 const list=h.node('pinnedResultsList');assert.equal(list.children.length,2);assert.equal(list.children[0].children[2].textContent,first.text);
 assert.equal(h.node('findResultsBody').scrollTop,600);assert.equal(h.node('findResultsBody').scrollLeft,240);
});
test('history, result analysis and real Analyse coexist with their own complete provenance',()=>{
 const h=setup();h.pin({pinResultIndex:'0'});
 h.state.searchResultHistory=[{id:42,report:{hits:[{path:'/old/other.txt',fileName:'other.txt',matches:[{line:91,column:3,lineText:'old result'}]}]}}];
 h.pin({pinResultIndex:'0',pinSearchBatchId:'42'});
 h.context.analysedRows=[{path:'/filtered/a.txt',line:38,column:2,text:'capture\nresult',fields:{value:'42'}}];h.pin({pinAnalysisRow:'0'});
 h.context.addPinnedResults([{kind:'analyse',text:'analysis\nfull block',sources:[{path:'/analyse/z.txt',fileName:'z.txt',line:100,column:1}],analysis:{sourceLine:100,text:'analysis\nfull block',matchingPatternIds:[8],styledSegments:[]}}]);
 assert.equal(h.state.pinnedResults.length,4);assert.equal(h.state.pinnedResults[1].sources[0].path,'/old/other.txt');
 assert.equal(h.state.pinnedResults[2].fields.value,'42');assert.equal(h.state.pinnedResults[3].analysis.text,'analysis\nfull block');
});
test('remove only one, keep sibling DOM/scroll, then clear all and restore focus',()=>{
 const h=setup();h.pin({pinResultIndex:'0'});h.match.line=24;h.pin({pinResultIndex:'0'});
 const list=h.node('pinnedResultsList');const second=list.children[1];const id=h.state.pinnedResults[0].id;
 h.context.unpinSearchResult(id);assert.equal(h.state.pinnedResults.length,1);assert.equal(list.children[0],second);assert.equal(list.scrollTop,600);
 assert.equal(h.focused().dataset.unpinId,h.state.pinnedResults[0].id);
 h.context.unpinSearchResult();assert.equal(h.state.pinnedResults.length,0);assert.equal(list.children.length,0);assert.equal(h.state.results,h.report);assert.equal(h.focused(),h.node('bottomSearchResultsTab'));
});
test('pane switching, a new search, clearing results, closing source and dock retain every Pin',async()=>{
 const h=setup();h.pin({pinResultIndex:'0'});h.match.line=24;h.pin({pinResultIndex:'0'});const pins=h.state.pinnedResults;
 h.context.openBottomResults('analyse');h.context.clearSearchResults();assert.equal(h.state.pinnedResults,pins);
 h.state.results={total:0,hits:[]};h.context.openBottomResults('search');assert.equal(h.state.pinnedResults,pins);
 await h.context.closeDocument(1);h.context.closeBottomResults();h.context.openBottomResults('analyse');
 assert.equal(h.state.pinnedResults,pins);assert.equal(h.node('pinnedSearchComparison').classList.contains('hidden'),false);assert.equal(h.node('pinnedResultsList').children.length,2);
});
test('stale rows are ignored and compact layout remains bounded outside scrolling/swappable panes',()=>{
 const h=setup();h.pin({pinResultIndex:'0'});const pins=h.state.pinnedResults;
 h.pin({pinResultIndex:'-1'});h.pin({pinResultIndex:'0',pinSearchBatchId:'missing'});h.pin({pinAnalysisRow:'0'});assert.equal(h.state.pinnedResults,pins);
 assert.equal(h.context.bottomResultsMaxHeight(),320);
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.ok(html.indexOf('id="pinnedSearchComparison"')<html.indexOf('class="bottom-results-content"'));
 const save=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='saveSession');assert.doesNotMatch(save.getText(ast),/pinnedResults/);
 assert.match(html,/id="pinSelectedSearchResultsButton"/);assert.match(source,/selection\.getRangeAt/);
});
