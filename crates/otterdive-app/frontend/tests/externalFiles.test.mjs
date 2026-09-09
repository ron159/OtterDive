import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Run the actual application functions with controlled disk I/O and dialogs.
const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['checkExternalFiles', 'saveDocument']);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(ast)).join('\n');
const js = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(options = {}) {
  const doc = { id: 1, path: '/file.txt', title: 'file.txt', diskRevision: 'old', text: 'local',
    encoding: 'UTF-8', dirty: false, version: 1, ...options.doc };
  const calls = { prompts: [], alerts: [], reads: 0, saves: [], refreshed: 0 };
  const context = {
    appReady: true, checkingExternalFiles: false, busyDepth: 0,
    confirmResolver: null, unsavedResolver: null, textInputResolver: null,
    state: { restoring: false, documents: [doc], activeId: 1, searchRevision: 0 },
    document: { visibilityState: 'visible' },
    syncMarkdownModelFromEditor() {}, cancelAutoSave() {},
    documentVersion: doc => doc.version,
    askConfirm: async prompt => { calls.prompts.push(prompt); return options.reload ?? false; },
    showAlert: async prompt => { calls.alerts.push(prompt); },
    invoke: async (command, args) => {
      if (command === 'file_revisions') {
        await options.onCheck?.(context, doc);
        return [{ path: doc.path, revision: options.revision ?? 'new' }];
      }
      if (command === 'reopen_path_with_encoding') {
        calls.reads++;
        await options.onRead?.(context, doc);
        return { ...doc, text: 'external', diskRevision: 'new' };
      }
      if (command === 'save_document') {
        calls.saves.push(args.request);
        return { ...doc, diskRevision: 'saved' };
      }
      throw new Error(command);
    },
    editor: { saveViewState: () => ({ position: 20 }), restoreViewState() {} },
    applyDocumentDto(doc, dto) { Object.assign(doc, dto, { dirty: false, externalRevision: undefined }); calls.refreshed++; },
    analysePanel: { notifyDocumentChanged() {} }, attachEditorModel() {}, renderAll() {}, renderChrome() {},
    scheduleSessionSave() {}, log() {},
    ensureDocumentModel: () => ({ getValue: () => doc.text, getAlternativeVersionId: () => doc.version }),
    withBusy: async (_, task) => task(), Blob,
    cancelDocumentSizeUpdate() {}, applyDetectedDocumentLanguage() {},
  };
  vm.createContext(context);
  vm.runInContext(js, context);
  return { doc, calls, context, check: () => context.checkExternalFiles(), save: automatic => context.saveDocument(doc, false, automatic) };
}

test('clean file reloads with view position; unchanged file does not reload', async () => {
  const h = harness();
  await h.check();
  assert.equal(h.doc.text, 'external');
  assert.equal(h.doc.viewState.position, 20);
  assert.equal(h.calls.prompts.length, 0);
  await h.check();
  assert.equal(h.calls.reads, 1);
  const unchanged = harness({ revision: 'old' });
  await unchanged.check();
  assert.equal(unchanged.calls.reads, 0);
});

test('dirty file retained on cancel; polling and auto-save never override decision', async () => {
  const h = harness({ doc: { dirty: true } });
  await h.check();
  await h.check();
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.doc.text, 'local');
  assert.equal(h.doc.externalRevision, 'new');
  assert.equal(h.calls.reads, 0);
  assert.equal(await h.save(true), false);
  assert.equal(h.calls.saves.length, 0);
});

test('confirmed reload discards local edits', async () => {
  const h = harness({ doc: { dirty: true }, reload: true });
  await h.check();
  assert.equal(h.doc.text, 'external');
  assert.equal(h.doc.dirty, false);
});

test('deletion preserves buffer and only alerts once', async () => {
  const h = harness({ revision: 'missing' });
  await h.check();
  await h.check();
  assert.equal(h.doc.text, 'local');
  assert.equal(h.calls.alerts.length, 1);
  assert.equal(h.doc.dirty, true);
  assert.equal(h.calls.reads, 0);
});

test('editing during disk read is retained and prompted on next check', async () => {
  const h = harness({ onRead: (_, doc) => { doc.version++; doc.dirty = true; doc.text = 'new typing'; } });
  await h.check();
  assert.equal(h.calls.refreshed, 0);
  assert.equal(h.doc.text, 'new typing');
  await h.check();
  assert.equal(h.calls.prompts.length, 1);
});

test('closed document and stale poll after save are ignored', async () => {
  for (const onCheck of [(ctx) => { ctx.state.documents = []; }, (_, doc) => { doc.diskRevision = 'saved'; }]) {
    const h = harness({ onCheck });
    await h.check();
    assert.equal(h.calls.reads, 0);
  }
});

test('background tab reloads without stealing active editor position', async () => {
  const h = harness();
  h.context.state.activeId = 2;
  h.doc.viewState = { position: 35 };
  await h.check();
  assert.equal(h.doc.viewState.position, 35);
  assert.equal(h.context.state.activeId, 2);
});

test('manual save requires explicit overwrite and passes disk revision to backend', async () => {
  const cancelled = harness({ doc: { dirty: true } });
  assert.equal(await cancelled.save(false), false);
  assert.equal(cancelled.calls.saves.length, 0);
  const approved = harness({ doc: { dirty: true }, reload: true });
  assert.equal(await approved.save(false), true);
  assert.equal(approved.calls.saves[0].expectedRevision, 'new');
  assert.equal(approved.doc.diskRevision, 'saved');
  assert.equal(approved.doc.externalRevision, undefined);
  assert.equal(approved.doc.saving, false);
});

test('normal auto-save has no prompt; in-flight save and other dialogs defer polling', async () => {
  const h = harness({ revision: 'old', doc: { dirty: true } });
  assert.equal(await h.save(true), true);
  assert.equal(h.calls.prompts.length, 0);
  for (const setup of [ctx => { ctx.confirmResolver = () => {}; }, ctx => { ctx.state.documents[0].saving = true; }]) {
    const deferred = harness();
    setup(deferred.context);
    await deferred.check();
    assert.equal(deferred.calls.reads, 0);
  }
});


test('file recreation after deletion is checked again without losing retained content', async () => {
  const options = { revision: 'missing' };
  const h = harness(options);
  await h.check();
  options.revision = 'recreated';
  await h.check();
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.doc.text, 'local');
});

test('reload failure can retry and a changed encoding prevents stale reload', async () => {
  let fail = true;
  const h = harness({ onRead: () => { if (fail) throw new Error('temporarily unavailable'); } });
  await h.check();
  assert.equal(h.calls.refreshed, 0);
  fail = false;
  await h.check();
  assert.equal(h.calls.refreshed, 1);
  const changed = harness({ onRead: (_, doc) => { doc.encoding = 'UTF-16 LE'; } });
  await changed.check();
  assert.equal(changed.calls.refreshed, 0);
});
