import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='bindPagedDocumentControls');
const js=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function setup(){
 const nodes=new Map(), calls=[];let scroll;const doc={paged:true,fileSize:50e6};
 const controller={busy:false,page:{startOffset:262144,nextOffset:524288,hasMore:true},load:(target,transition)=>calls.push({target,transition}),cancel(){}};
 let top=0;const height=500,total=5000;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}});return nodes.get(id);};
 const context={activeDocument:()=>doc,pagedController:()=>controller,$:node,pagedScrollGuard:false,renderPagedDocumentControls(){},editor:{getLayoutInfo:()=>({height}),getScrollTop:()=>top,getScrollHeight:()=>total,onDidScrollChange:fn=>{scroll=fn;}}};
 vm.createContext(context);vm.runInContext(js,context);context.bindPagedDocumentControls();
 return {doc,controller,calls,node,context,scrollTo(value){top=value;scroll({scrollTop:top,scrollTopChanged:true});},wheel(deltaY,extra={}){let prevented=false;node('editor').listeners.wheel({deltaY,preventDefault(){prevented=true;},...extra});return prevented;}};
}
test('normal editor scrolling automatically reads adjacent pages without navigation-button clicks',()=>{
 const h=setup();h.scrollTo(2500);assert.equal(h.calls.length,0);h.scrollTo(4100);assert.equal(h.calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])),{target:{offset:524288},transition:'append'});
 h.scrollTo(100);assert.equal(h.calls.at(-1).transition,'prepend');assert.equal(h.calls.at(-1).target.offset,262143);
});
test('busy/non-paged and programmatic model changes cannot create overlapping reads',()=>{
 const h=setup();h.controller.busy=true;h.scrollTo(4600);assert.equal(h.calls.length,0);h.controller.busy=false;h.context.pagedScrollGuard=true;h.scrollTo(4700);assert.equal(h.calls.length,0);h.context.pagedScrollGuard=false;h.doc.paged=false;h.scrollTo(4800);assert.equal(h.calls.length,0);
});
test('wheel at a window boundary reads the neighbor while modified zoom gestures are preserved',()=>{
 const h=setup();assert.equal(h.wheel(-1,{ctrlKey:true}),false);assert.equal(h.calls.length,0);assert.equal(h.wheel(-1),true);assert.equal(h.calls.at(-1).transition,'prepend');h.controller.page.startOffset=0;assert.equal(h.wheel(-1),false);
});
