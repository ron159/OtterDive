import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Run the actual application functions with controlled disk I/O and dialogs.
const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['checkExternalFiles', 'saveDocument', 'handleMissingDocument', 'closeDocument',
  'confirmDocumentCanClose', 'shouldPromptToSave', 'removeOpenDocumentsForDeletedPath', 'confirmCloseAll', 'flushSessionBeforeClose',
  'closingDocumentSignature', 'setClosingEditorsLocked', 'blockInputDuringWindowClose', 'bindWindowCloseGuard', 'requestWindowClose',
  'applyImageMigrations', 'replaceImageReference', 'markdownImageContentMask']);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(ast)).join('\n');
const js = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(options = {}) {
  const doc = { id: 1, path: '/file.txt', title: 'file.txt', diskRevision: 'old', text: 'local',
    encoding: 'UTF-8', dirty: false, version: 1, ...options.doc };
  const calls = { prompts: [], alerts: [], reads: 0, saves: [], refreshed: 0, recovery: [], locks: [], closed: 0, reloads: [], persistenceErrors: new Map() };
  const app = { inert: false };
  let modelText = doc.text;
  const model = { getValue: () => modelText, getAlternativeVersionId: () => doc.version, isDisposed: () => !!options.disposed, pushStackElement() {} };
  const context = {
    appReady: true, checkingExternalFiles: false, busyDepth: 0, editorBusyDepth: 0,
    closingEditorsLocked: false, closingAppWasInert: false, windowCloseConfirmed: false, windowCloseInProgress: false,
    $: () => app, activeDocument: () => context.state.documents[0], isReadingDocument: () => false,
    markdownEditor: { setReadOnly: readOnly => { calls.locks.push(['markdown', readOnly]); } },
    sideDocumentId: 1, sideEditor: { updateOptions: ({ readOnly }) => { calls.locks.push(['side', readOnly]); } },
    appWindow: { onCloseRequested: handler => { context.nativeCloseHandler = handler; }, close: async () => { calls.closed++; } },
    confirmResolver: null, unsavedResolver: null, textInputResolver: null,
    state: { restoring: false, documents: [doc], activeId: 1, searchRevision: 0, missingFileBehavior: options.behavior ?? 'keep', workbench: { historyEnabled: false, recoveryEnabled: true } },
    document: { visibilityState: 'visible' },
    window: { clearTimeout() {}, addEventListener() {}, removeEventListener() {} }, sessionTimer: 0,
    recoveryTimers: new Map(), recoveryIds: new Map(), closingDiscardedVersions: new Map(), recoveryQueue: Promise.resolve(),
    saveSession: async () => { calls.recovery.push('session'); await options.onSession?.(context, doc); },
    showExternalConflict: async () => { calls.prompts.push('diff'); return options.reload ?? false; },
    confirmDiskOverwrite: async () => { calls.prompts.push('overwrite diff'); return options.reload ?? false; },
    recoveryKey: doc => `file:${doc.path}`, migrateDocumentImages: async () => options.migrations ?? [], preserveHistory: async () => {},
    pickSavePath: async () => options.savePath ?? doc.path,
    replaceModelText: (_, text) => { modelText = text; doc.version++; },
    setModelText: text => { modelText = text; doc.version++; doc.dirty = true; },
    scheduleRecovery: doc => { calls.recovery.push(`schedule:${doc.id}`); },
    persistRecovery: async doc => { calls.recovery.push(`persist:${doc.id}`); if(options.recoveryFailure) throw new Error('disk full'); },
    discardRecovery: (_, key) => { calls.recovery.push(`discard:${key}`); },
    writingStatsCache: new Map(), markdownSessions: new Map(), closeSideEditorFor() {},
    syncMarkdownModelFromEditor() {}, cancelAutoSave() {},
    documentVersion: doc => doc.version,
    askConfirm: async prompt => { calls.prompts.push(prompt); return options.reload ?? false; },
    showAlert: async prompt => { calls.alerts.push(prompt); },
    askUnsavedChoice: async (...prompt) => { calls.prompts.push(prompt); return options.closeChoice ?? 'cancel'; },
    invoke: async (command, args) => {
      if (command === 'file_revisions') {
        await options.onCheck?.(context, doc);
        return [{ path: args.paths[0], revision: options.revision ?? 'new' }];
      }
      if (command === 'reopen_path_with_encoding' || command === 'open_path') {
        calls.reads++;
        calls.reloads.push({ command, args });
        await options.onRead?.(context, doc);
        return { ...doc, text: 'external', encoding: options.readEncoding ?? (command === 'open_path' ? 'UTF-8' : args.request.encoding), diskRevision: options.readRevision ?? 'new' };
      }
      if (command === 'save_document') {
        calls.saves.push(args.request);
        if (options.saveFailure) throw new Error('disk full');
        const saved = { ...doc, path: args.request.path, diskRevision: 'saved' };
        await options.onSave?.(context, doc);
        return saved;
      }
      if(command === 'delete_snapshot') { calls.recovery.push(`delete:${args.request.id}`); await options.onDeleteSnapshot?.(context, doc); return; }
      throw new Error(command);
    },
    editor: { saveViewState: () => ({ position: 20 }), restoreViewState() {}, updateOptions: ({ readOnly }) => { calls.locks.push(['main', readOnly]); } },
    applyDocumentDto(doc, dto) { Object.assign(doc, dto, { dirty: false, externalRevision: undefined }); calls.refreshed++; },
    analysePanel: { notifyDocumentChanged() {} }, attachEditorModel() {}, renderAll() {}, renderChrome() {},
    scheduleSessionSave() {}, log() {},
    reportPersistenceError: (key, label, error) => calls.persistenceErrors.set(key, `${label}: ${String(error)}`),
    clearPersistenceError: key => calls.persistenceErrors.delete(key),
    ensureDocumentModel: () => model,
    withBusy: async (_, task) => task(), Blob,
    cancelDocumentSizeUpdate() {}, applyDetectedDocumentLanguage() {},
    rememberClosedDocument() {}, disposeMarkdownEditor() {}, scheduleAutoSave() {},
    createUntitledDocument: () => ({ id: 2, path: null, text: '', dirty: false }),
    activateDocument: id => { context.state.activeId = id; },
    pathMatchesTarget: (path, target, isDir) => path === target || (isDir && path.startsWith(target + '/')),
  };
  vm.createContext(context);
  vm.runInContext(js, context);
  return { doc, calls, context, model, check: () => context.checkExternalFiles(), save: automatic => context.saveDocument(doc, false, automatic) };
}

test('a failed save remains visible and leaves unsaved content intact', async () => {
  const h = harness({ saveFailure: true, revision: 'old', doc: { dirty: true } });
  await assert.rejects(h.save(true), /disk full/);
  assert.equal(h.doc.dirty, true);
  assert.equal(h.model.getValue(), 'local');
  assert.match(h.calls.persistenceErrors.get('save:1') ?? '', /file.txt.*disk full/);
  assert.equal(h.doc.saving, false);
});

test('a successful save clears its own error without hiding a failed recovery', async () => {
  const h = harness({ revision: 'old', doc: { dirty: true } });
  h.calls.persistenceErrors.set('save:1', 'previous save failure');
  h.calls.persistenceErrors.set('recovery:1', 'recovery failure');
  assert.equal(await h.save(false), true);
  assert.equal(h.calls.persistenceErrors.has('save:1'), false);
  assert.equal(h.calls.persistenceErrors.get('recovery:1'), 'recovery failure');
});

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

test('keep behavior preserves a removed buffer without repeated dialogs or auto-save', async () => {
  const h = harness({ revision: 'missing' });
  await h.check();
  await h.check();
  assert.equal(h.doc.text, 'local');
  assert.equal(h.calls.alerts.length, 0);
  assert.equal(h.doc.dirty, true);
  assert.equal(h.doc.externalRevision, 'missing');
  assert.equal(h.calls.reads, 0);
  assert.equal(await h.save(true), false);
});

test('close behavior closes a clean missing file and creates an empty tab when needed', async () => {
  const h = harness({ revision: 'missing', behavior: 'close' });
  await h.check();
  assert.equal(h.context.state.documents.includes(h.doc), false);
  assert.equal(h.context.state.documents.length, 1);
  assert.equal(h.context.state.documents[0].path, null);
  assert.equal(h.calls.prompts.length, 0);
});

test('closing a missing background file preserves the active tab', async () => {
  const h = harness({ revision: 'missing', behavior: 'close' });
  h.context.state.documents.push({ id: 3, path: null });
  h.context.state.activeId = 3;
  await h.check();
  assert.equal(h.context.state.activeId, 3);
  assert.equal(h.context.state.documents.includes(h.doc), false);
});

test('close behavior still protects unsaved edits and respects cancellation once', async () => {
  const h = harness({ revision: 'missing', behavior: 'close', doc: { dirty: true } });
  await h.check();
  await h.check();
  assert.equal(h.context.state.documents.includes(h.doc), true);
  assert.equal(h.doc.text, 'local');
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.doc.externalRevision, 'missing');

  const discarded = harness({ revision: 'missing', behavior: 'close', doc: { dirty: true }, closeChoice: 'discard' });
  await discarded.check();
  assert.equal(discarded.context.state.documents.includes(discarded.doc), false);
});

test('workspace deletion uses the same setting for files inside the deleted directory', async () => {
  for (const behavior of ['keep', 'close']) {
    const h = harness({ behavior, doc: { path: '/folder/file.txt', dirty: true } });
    await h.context.removeOpenDocumentsForDeletedPath('/folder', true);
    assert.equal(h.context.state.documents.includes(h.doc), behavior === 'keep');
    assert.equal(h.calls.prompts.length, 0, 'tree deletion already confirmed unsaved changes');
    if (behavior === 'keep') assert.equal(h.doc.externalRevision, 'missing');
  }
});

test('saving a missing file while closing requires confirmation and keeps cancelled saves open', async () => {
  for (const reload of [false, true]) {
    const h = harness({ revision: 'missing', behavior: 'close', doc: { dirty: true }, closeChoice: 'save', reload });
    await h.check();
    assert.equal(h.context.state.documents.includes(h.doc), !reload);
    assert.equal(h.calls.saves.length, reload ? 1 : 0);
    if (reload) assert.equal(h.calls.saves[0].expectedRevision, 'missing');
    else assert.equal(h.doc.text, 'local');
  }
});

test('missing read-only buffers follow the setting without becoming editable or prompting to save', async () => {
  for (const behavior of ['keep', 'close']) {
    const h = harness({ revision: 'missing', behavior, doc: { readOnly: true } });
    await h.check();
    assert.equal(h.context.state.documents.includes(h.doc), behavior === 'keep');
    assert.equal(h.doc.readOnly, true);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.doc.dirty, false);
  }
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


test('editing or changing encoding during save keeps pending changes and recovery', async () => {
  const h = harness({ revision: 'old', doc: { dirty: true }, onSave: (_, doc) => { doc.version++; doc.encoding = 'GBK'; doc.lineEnding = 'CRLF'; } });
  assert.equal(await h.save(true), true);
  assert.equal(h.doc.dirty, true);
  assert.equal(h.doc.metadataDirty, true);
  assert.equal(h.doc.encoding, 'GBK');
  assert.equal(h.doc.lineEnding, 'CRLF');
  assert.equal(h.calls.saves[0].sourcePath, '/file.txt');
  assert.deepEqual(h.calls.recovery, ['persist:1']);
});
test('failed recovery write after save retains the last durable backup', async () => {
  const h = harness({ revision: 'old', recoveryFailure: true, onSave: (_, doc) => { doc.version++; } });
  await h.save(true);
  assert.equal(h.doc.dirty, true);
  assert.deepEqual(h.calls.recovery, ['persist:1', 'schedule:1']);
});
test('quit commits discard decisions only after all documents agree to close', async () => {
  const h = harness({ doc: { dirty: true } });
  h.context.state.documents.push({ ...h.doc, id: 2 });
  let call = 0;
  h.context.askUnsavedChoice = async () => ++call === 1 ? 'discard' : 'cancel';
  assert.equal(await h.context.confirmCloseAll(), false);
  assert.equal(h.context.closingDiscardedVersions.size, 0);
  assert.equal(h.calls.recovery.length, 0);
});
test('quit flushes recovery before session and removes explicitly discarded snapshots', async () => {
  const h = harness({ doc: { dirty: true }, closeChoice: 'discard' });
  h.context.recoveryIds.set('file:/file.txt', 12);
  assert.equal(await h.context.confirmCloseAll(), true);
  assert.equal(await h.context.flushSessionBeforeClose(), true);
  assert.deepEqual(h.calls.recovery, ['session', 'delete:12']);
  const pending = harness({ doc: { dirty: true, path: null } });
  assert.equal(await pending.context.confirmCloseAll(), true);
  assert.equal(await pending.context.flushSessionBeforeClose(), true);
  assert.deepEqual(pending.calls.recovery, ['persist:1', 'session']);
});
test('new edits after discard confirmation cancel quit and preserve recovery', async () => {
  const h = harness({ doc: { dirty: true }, closeChoice: 'discard' });
  await h.context.confirmCloseAll();
  h.doc.version++;
  assert.equal(await h.context.flushSessionBeforeClose(), false);
  assert.deepEqual(h.calls.recovery, ['persist:1', 'schedule:1']);
  assert.equal(h.calls.alerts.length, 1);
});


test('confirmed external reload removes the discarded recovery snapshot', async () => {
  const h = harness({ doc: { dirty: true }, reload: true });
  await h.check();
  assert.equal(h.doc.dirty, false);
  assert.deepEqual(h.calls.recovery, ['discard:undefined']);
});

test('saving documents cannot be closed or discarded until the write finishes', async () => {
  for (const dirty of [false, true]) {
    const h = harness({ doc: { dirty, saving: true }, closeChoice: 'discard' });
    assert.equal(await h.context.closeDocument(h.doc.id), false);
    assert.equal(h.context.state.documents.includes(h.doc), true);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.calls.alerts[0].title, '文档正在保存');
  }
});

test('save completion ignores a removed or disposed document model', async () => {
  const options = { revision: 'old', doc: { dirty: true }, onSave: ctx => { ctx.state.documents = []; options.disposed = true; } };
  const h = harness(options);
  assert.equal(await h.save(false), true);
  assert.equal(h.doc.diskRevision, 'old');
  assert.deepEqual(h.calls.recovery, []);
});

test('quit locks all editors and rejects edits or metadata changes during session write', async () => {
  for (const change of [doc => { doc.version++; }, doc => { doc.encoding = 'GBK'; }, doc => { doc.lineEnding = 'CRLF'; }]) {
    const h = harness({ doc: { dirty: true }, closeChoice: 'discard', onSession: (ctx, doc) => {
      assert.equal(ctx.closingEditorsLocked, true);
      assert.equal(ctx.$().inert, true);
      change(doc);
    } });
    await h.context.confirmCloseAll();
    assert.equal(await h.context.flushSessionBeforeClose(), false);
    assert.deepEqual(h.calls.recovery, ['session', 'persist:1', 'schedule:1']);
    assert.deepEqual(h.calls.locks, [['main', true], ['markdown', true], ['side', true], ['main', false], ['markdown', false], ['side', false]]);
    assert.equal(h.context.$().inert, false);
  }
});

test('quit recreates a durable backup if a late edit arrives while deleting old recovery', async () => {
  const h = harness({ doc: { dirty: true }, closeChoice: 'discard', onDeleteSnapshot: (_, doc) => { doc.version++; } });
  h.context.recoveryIds.set('file:/file.txt', 12);
  await h.context.confirmCloseAll();
  assert.equal(await h.context.flushSessionBeforeClose(), false);
  assert.deepEqual(h.calls.recovery, ['session', 'delete:12', 'persist:1', 'schedule:1']);
});

test('quit rejects changes to the document collection during persistence', async () => {
  const h = harness({ onSession: ctx => { ctx.state.documents.push({ id: 2, path: null, text: 'new draft', dirty: true }); } });
  assert.equal(await h.context.flushSessionBeforeClose(), false);
  assert.deepEqual(h.calls.recovery, ['session', 'persist:2', 'schedule:1', 'schedule:2']);
});

test('native repeated close requests cannot bypass an in-flight flush', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness({ onSession: async () => { entered(); await gate; } });
  h.context.bindWindowCloseGuard();
  const closing = h.context.requestWindowClose();
  await started;
  let prevented = false;
  await h.context.nativeCloseHandler({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.calls.closed, 0);
  assert.equal(h.context.windowCloseConfirmed, false);
  release();
  await closing;
  assert.equal(h.calls.closed, 1);
  assert.equal(h.context.windowCloseConfirmed, true);
  assert.equal(h.context.windowCloseInProgress, false);
});


test('failed Save As keeps original image paths in the model', async () => {
  const h = harness({ doc: { dirty: true, text: '![image](old/picture.png)' }, savePath: '/new/file.md', revision: 'missing',
    migrations: [{ source: 'old/picture.png', relativePath: 'assets/picture.png' }], saveFailure: true });
  await assert.rejects(h.context.saveDocument(h.doc, true), /disk full/);
  assert.equal(h.calls.saves[0].text, '![image](<assets/picture.png>)');
  assert.equal(h.model.getValue(), '![image](old/picture.png)');
  assert.equal(h.doc.path, '/file.txt');
  assert.equal(h.doc.dirty, true);
});

test('successful image migration preserves concurrent typing and leaves it dirty', async () => {
  const h = harness({ doc: { dirty: true, text: '![image](old/picture.png)' }, savePath: '/new/file.md', revision: 'missing',
    migrations: [{ source: 'old/picture.png', relativePath: 'assets/picture.png' }],
    onSave: ctx => { ctx.setModelText('![image](old/picture.png)\nnew typing'); } });
  assert.equal(await h.context.saveDocument(h.doc, true), true);
  assert.equal(h.calls.saves[0].text, '![image](<assets/picture.png>)');
  assert.equal(h.model.getValue(), '![image](<assets/picture.png>)\nnew typing');
  assert.equal(h.doc.path, '/new/file.md');
  assert.equal(h.doc.dirty, true);
  assert.deepEqual(h.calls.recovery, ['persist:1', 'discard:file:/file.txt']);
});

function useRealImageMigration(h, result) {
  const implementation = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['migrateDocumentImages', 'markdownImageReferences'].includes(node.name?.text))
    .map(node => node.getText(ast)).join('\n');
  h.context.state.workbench.imageCopy = true;
  h.context.documentText = () => h.model.getValue();
  h.context.isMarkdownLikeDocument = () => true;
  h.calls.warnings = [];
  h.context.log = message => h.calls.warnings.push(message);
  const invoke = h.context.invoke;
  h.context.invoke = async (command, args) => command === 'migrate_markdown_assets'
    ? result : invoke(command, args);
  vm.runInContext(ts.transpileModule(implementation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h.context);
}

test('missing images retain their references while a new Markdown document saves', async () => {
  const text = '# Draft\n![planned](not-yet-created.png)';
  const h = harness({ doc: { path: null, title: 'Draft.md', dirty: true, text }, savePath: '/Draft.md', revision: 'missing' });
  useRealImageMigration(h, [{ source: 'not-yet-created.png', relativePath: null, warning: 'image missing' }]);
  assert.equal(await h.save(false), true);
  assert.equal(h.calls.saves[0].text, text);
  assert.equal(h.model.getValue(), text);
  assert.equal(h.doc.path, '/Draft.md');
  assert.ok(h.calls.warnings.some(message => message.includes('not-yet-created.png') && message.includes('image missing')));
});

test('mixed image migration matches sources even after an intermediate failure and reordered results', async () => {
  const text = '![first](first%20image.png)\n![missing](missing.png)\n![last](last.png)';
  const h = harness({ doc: { dirty: true, text }, savePath: '/new/file.md', revision: 'missing' });
  useRealImageMigration(h, [
    { source: 'last.png', relativePath: 'assets/last.png' },
    { source: 'missing.png', relativePath: null, warning: 'image missing' },
    { source: 'first image.png', relativePath: 'assets/first%20image.png' },
  ]);
  assert.equal(await h.context.saveDocument(h.doc, true), true);
  assert.equal(h.calls.saves[0].text, '![first](<assets/first%20image.png>)\n![missing](missing.png)\n![last](<assets/last.png>)');
});

test('a missing image warning does not hide a real document write failure', async () => {
  const text = '![missing](missing.png)';
  const h = harness({ doc: { dirty: true, text }, savePath: '/new/file.md', revision: 'missing', saveFailure: true });
  useRealImageMigration(h, [{ source: 'missing.png', relativePath: null, warning: 'image missing' }]);
  await assert.rejects(h.context.saveDocument(h.doc, true), /disk full/);
  assert.equal(h.model.getValue(), text);
  assert.equal(h.doc.path, '/file.txt');
  assert.equal(h.doc.dirty, true);
});

test('Save As guards both existing and newly created destination revisions', async () => {
  for (const revision of ['destination-version', 'missing']) {
    const h = harness({ doc: { dirty: true }, savePath: '/new/file.txt', revision });
    assert.equal(await h.context.saveDocument(h.doc, true), true);
    assert.equal(h.calls.saves[0].expectedRevision, revision);
    assert.equal(h.calls.saves[0].sourcePath, '/file.txt');
    assert.equal(h.calls.saves[0].path, '/new/file.txt');
  }
});


test('dirty conflict reload uses the same automatic decoding as the comparison', async () => {
  const h = harness({ doc: { dirty: true, encoding: 'UTF-16 LE', sourceEncoding: 'UTF-8' }, reload: true });
  await h.check();
  assert.equal(h.calls.reloads[0].command, 'open_path');
  assert.equal(h.doc.encoding, 'UTF-8');
  assert.equal(h.doc.text, 'external');
  assert.equal(h.doc.dirty, false);
});

test('a disk revision changed during conflict confirmation is preserved and prompted again', async () => {
  const options = { doc: { dirty: true }, reload: true, readRevision: 'newer' };
  const h = harness(options);
  await h.check();
  assert.equal(h.calls.refreshed, 0);
  assert.equal(h.doc.text, 'local');
  assert.equal(h.doc.externalRevision, undefined);
  assert.equal(h.doc.diskRevision, 'old');
  options.revision = 'newer';
  await h.check();
  assert.equal(h.calls.prompts.length, 2);
  assert.equal(h.calls.refreshed, 1);
});

test('clean reload keeps the source decoder and guards encoding metadata changes', async () => {
  const h = harness({ doc: { encoding: 'UTF-8', sourceEncoding: 'GBK' } });
  await h.check();
  assert.equal(h.calls.reloads[0].command, 'reopen_path_with_encoding');
  assert.equal(h.calls.reloads[0].args.request.encoding, 'GBK');
  assert.equal(h.doc.encoding, 'GBK');
  const changed = harness({ doc: { dirty: true, sourceEncoding: 'UTF-8' }, reload: true,
    onRead: (_, doc) => { doc.encoding = 'UTF-16 LE'; } });
  await changed.check();
  assert.equal(changed.calls.refreshed, 0);
  assert.equal(changed.doc.text, 'local');
  assert.equal(changed.doc.externalRevision, undefined);
});

test('internal unconfirmed close still refuses an in-flight save', async () => {
  const h = harness({ doc: { saving: true }, closeChoice: 'discard' });
  assert.equal(await h.context.closeDocument(h.doc.id, false), false);
  assert.equal(h.context.state.documents.includes(h.doc), true);
  assert.equal(h.calls.alerts[0].title, '文档正在保存');
  assert.deepEqual(h.calls.recovery, []);
});
