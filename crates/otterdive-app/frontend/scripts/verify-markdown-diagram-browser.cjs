// Optional development-only browser check. No product dependency is added.
// Start Vite first. Resolve Playwright through NODE_PATH or PLAYWRIGHT_MODULE_PATH.
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright'));
} catch {
  console.error('缺少可选 Playwright 运行时。请通过 NODE_PATH 指向已有 node_modules，或通过 PLAYWRIGHT_MODULE_PATH 指定 playwright 包路径。');
  process.exit(1);
}
const path = require('node:path');
const baseUrl = process.env.OTTERDIVE_BASE_URL || 'http://127.0.0.1:1420';
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  try {
    const response = await fetch(new URL('/src/markdownDiagramActions.ts', baseUrl), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`无法连接 OtterDive 开发服务器 ${baseUrl}，请先运行 npm run dev：${error.message}`);
  }
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const toolbarMatch = html.match(/<div id="markdownDiagramActions"[\s\S]*?<\/div>/);
    assert.ok(toolbarMatch, 'index.html 缺少图表导出工具条');
    const toolbar = toolbarMatch[0];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/diagram-export-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>body{margin:40px;font-family:Arial}#markdownPreview{height:600px;overflow:auto}.markdown-diagram{width:400px;height:250px;border:1px solid #aaa}#ordinaryImage{width:100px;height:100px}.markdown-diagram-actions{position:fixed;background:white;border:1px solid gray;padding:8px;z-index:100}.markdown-diagram-actions[hidden]{display:none}</style></head><body><main id="markdownPreview"><img id="ordinaryImage" alt="ordinary" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22green%22/%3E%3C/svg%3E"><div id="diagramFixture" class="markdown-diagram mermaid"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 250"><rect x="20" y="60" width="200" height="120" rx="10" fill="#99d4ff"/><text x="60" y="125" font-size="24">Diagram 1</text></svg></div></main><div id="markdownWysiwyg"></div>${toolbar}</body></html>` }));
    await page.goto(new URL('/diagram-export-fixture', baseUrl).href);
    await page.evaluate(async () => {
      window.diagramInvokes = []; window.diagramNotices = [];
      window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
        window.diagramInvokes.push({ cmd, args });
        if (cmd === 'pick_save_path') return window.cancelDiagramSave ? null : '/tmp/' + args.request.fileName;
        if (cmd === 'export_document_bytes' && window.failDiagramSave) throw new Error('fixture write failure');
        return null;
      } };
      const actions = await import('/src/markdownDiagramActions.ts');
      actions.bindMarkdownDiagramActions({ isNative: () => true, documentTitle: () => '测试.md', defaultDirectory: () => '/tmp', notify: message => window.diagramNotices.push(message) });
    });
    await page.locator('#ordinaryImage').hover();
    assert.equal(await page.locator('#markdownDiagramActions').isVisible(), false);
    await page.locator('#diagramFixture').hover();
    assert.equal(await page.locator('#markdownDiagramActions').isVisible(), true);
    await page.getByRole('button', { name: 'SVG', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#markdownDiagramExportStatus').textContent === '已导出');
    let writes = await page.evaluate(() => window.diagramInvokes.filter(call => call.cmd === 'export_document_bytes'));
    assert.equal(writes.length, 1);
    assert.match(Buffer.from(writes[0].args.request.bytes).toString('utf8'), /<svg[\s>]/);
    assert.match(writes[0].args.request.path, /测试-图表\.svg$/);
    await page.getByRole('button', { name: 'PNG', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#markdownDiagramExportStatus').textContent === '已导出');
    writes = await page.evaluate(() => window.diagramInvokes.filter(call => call.cmd === 'export_document_bytes'));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].args.request.bytes.slice(0, 8), [137,80,78,71,13,10,26,10]);
    await page.evaluate(() => { window.cancelDiagramSave = true; });
    await page.getByRole('button', { name: 'SVG', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#markdownDiagramExportStatus').textContent === '已取消');
    assert.equal(await page.evaluate(() => window.diagramInvokes.filter(call => call.cmd === 'export_document_bytes').length), 2);
    await page.evaluate(() => { window.cancelDiagramSave = false; window.failDiagramSave = true; });
    await page.getByRole('button', { name: 'SVG', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#markdownDiagramExportStatus').textContent.includes('fixture write failure'));
    assert.equal(await page.getByRole('button', { name: 'SVG', exact: true }).isEnabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#markdownDiagramActions').isVisible(), false);
    await page.locator('#diagramFixture').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('button', { name: 'SVG', exact: true }).evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#markdownDiagramActions').isVisible(), false);
    await page.evaluate(async () => {
      window.failDiagramSave = false;
      const root = document.querySelector('#markdownPreview');
      root.innerHTML = '<pre><code class="language-mermaid">graph TD; A[中文起点] --&gt; B[Diagram End];</code></pre>';
      const markdown = await import('/src/markdownEditor.ts');
      await markdown.renderMarkdownPreviewDiagrams(root, { darkMode: false });
    });
    await page.locator('#markdownPreview .markdown-diagram').hover();
    await page.getByRole('button', { name: 'PNG', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#markdownDiagramExportStatus').textContent.includes('正在导出'));
    const mermaidStatus = await page.locator('#markdownDiagramExportStatus').textContent();
    assert.equal(mermaidStatus, '已导出');
    const mermaidPayload = await page.evaluate(() => window.diagramInvokes.filter(call => call.cmd === 'export_document_bytes').at(-1));
    assert.deepEqual(mermaidPayload.args.request.bytes.slice(0, 8), [137,80,78,71,13,10,26,10]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', checks: ['ordinary image excluded', 'diagram hover toolbar', 'SVG native byte payload', 'PNG signature', 'cancel does not write', 'write errors visible and controls reenabled', 'keyboard Enter and Escape', 'real Mermaid Chinese diagram PNG'], sizes: writes.map(item => item.args.request.bytes.length), mermaidPngBytes: mermaidPayload.args.request.bytes.length, nativeIpc: 'mocked; no OS save dialog used' }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
