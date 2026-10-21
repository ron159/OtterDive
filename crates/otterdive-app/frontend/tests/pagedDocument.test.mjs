import assert from 'node:assert/strict';import test from 'node:test';
import { PagedDocumentController,pageLocalPosition } from '../src/pagedDocument.ts';
const page={text:'target',startOffset:262144,nextOffset:524288,size:40e6,startLine:100,startColumn:22,endLine:100,endColumn:28,hasMore:true};
function setup(){const pending=[];const commands=[];const applied=[];let states=0;const invoke=(command,args)=>{commands.push({command,args});if(command==='cancel_document_page')return Promise.resolve();return new Promise((resolve,reject)=>pending.push({resolve,reject}));};const controller=new PagedDocumentController({path:'/test',encoding:'UTF-8',revision:'disk'},invoke,p=>applied.push(p),()=>states++);return {controller,pending,commands,applied,states:()=>states};}
test('closing during initial page read cancels it and a late result cannot revive the tab',async()=>{const h=setup();const task=h.controller.load();h.controller.close();h.pending[0].resolve(page);assert.equal(await task,null);assert.equal(h.applied.length,0);assert.equal(h.controller.page,null);assert.equal(h.commands[1].command,'cancel_document_page');});
test('new requests supersede older reads and only the current page reaches the model',async()=>{const h=setup();const a=h.controller.load({offset:0});const b=h.controller.load({line:100,column:22});h.pending[1].resolve(page);assert.equal(await b,page);h.pending[0].resolve({...page,text:'stale'});assert.equal(await a,null);assert.equal(h.applied.length,1);assert.equal(h.controller.busy,false);assert.equal(h.controller.page.text,'target');});
test('cancel, error and retry clear busy state without altering the document data',async()=>{const h=setup();let task=h.controller.load();h.pending[0].reject(new Error('changed source'));assert.equal(await task,null);assert.equal(h.controller.busy,false);assert.match(h.controller.error,/changed source/);task=h.controller.load({offset:0});h.pending[1].resolve(page);await task;assert.equal(h.controller.error,'');assert.equal(h.controller.source.revision,'disk');});
test('global line and UTF16 column mapping respects a fragment of a very long line',()=>{assert.deepEqual(pageLocalPosition(page,100,25),{lineNumber:1,column:4});assert.deepEqual(pageLocalPosition(page,102,8),{lineNumber:3,column:8});});
test('continuous scrolling appends/prepends adjacent pages and retains only a bounded model window',async()=>{
 const h=setup();
 const pages=Array.from({length:5},(_,i)=>({...page,text:`page${i}\n`,startOffset:i*262144,nextOffset:(i+1)*262144,startLine:i*10+1,startColumn:1,endLine:(i+1)*10+1,endColumn:1}));
 let task=h.controller.load();h.pending[0].resolve(pages[0]);await task;
 for(let i=1;i<5;i++){task=h.controller.load({offset:pages[i].startOffset},'append');h.pending[i].resolve(pages[i]);await task;}
 assert.equal(h.controller.page.text,'page2\npage3\npage4\n');assert.equal(h.controller.page.startLine,21);assert.equal(h.controller.page.nextOffset,pages[4].nextOffset);
 task=h.controller.load({offset:pages[1].nextOffset-1},'prepend');h.pending[5].resolve(pages[1]);await task;
 assert.equal(h.controller.page.text,'page1\npage2\npage3\n');assert.equal(h.controller.page.startLine,11);
});
