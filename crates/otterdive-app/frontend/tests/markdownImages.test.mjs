import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/markdownImages.ts', import.meta.url))], bundle: true, format: 'esm', write: false });
const { markdownImageReferences, applyImageMigrations } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
test('image migration finds inline, HTML and reference images but ignores code examples', () => {
  const text = '![real](real.png)\n<img src="html.png">\n![reference][asset]\n[asset]: <ref%20image.png> "title"\n`![code](inline.png)`\n```md\n![example](fenced.png)\n```\n    ![code](indented.png)\n\\![escaped](escaped.png)\n';
  assert.deepEqual([...markdownImageReferences(text)], ['real.png', 'html.png', 'ref%20image.png']);
});
test('image rewriting preserves code, escaped syntax, titles and CRLF bytes', () => {
  const source = '![image](a.png "title")\r\n`![example](a.png)`\r\n```md\r\n![example](a.png)\r\n```\r\n\\![literal](a.png)\r\n![ref][id]\r\n[id]: <a.png> "caption"\r\n';
  const changed = applyImageMigrations(source, [{ source: 'a.png', relativePath: 'new%20folder/a.png' }]);
  assert.equal(changed, source.replace('![image](a.png', '![image](<new%20folder/a.png>').replace('[id]: <a.png>', '[id]: <new%20folder/a.png>'));
});

test('Save As uses complete balanced and escaped destinations while preserving titles and unused definitions', () => {
  const markdown = String.raw`![inline](plots/(v1)/image(2).png "title") ![escaped](img\(2\).png)
![ref][ref]
[ref]: <plots/(v1)/image(2).png>
[ordinary-link]: <plots/(v1)/image(2).png>`;
  assert.deepEqual(markdownImageReferences(markdown), ['plots/(v1)/image(2).png', 'img(2).png']);
  assert.equal(applyImageMigrations(markdown, [
    { source: 'plots/(v1)/image(2).png', relativePath: 'assets/a.png' },
    { source: 'img(2).png', relativePath: 'assets/b.png' },
  ]), `![inline](<assets/a.png> "title") ![escaped](<assets/b.png>)
![ref][ref]
[ref]: <assets/a.png>
[ordinary-link]: <plots/(v1)/image(2).png>`);
});

test('one migration never rewrites a newly generated destination again', () => {
  assert.equal(applyImageMigrations('![one](a.png) ![two](b.png)', [
    { source: 'a.png', relativePath: 'b.png' },
    { source: 'b.png', relativePath: 'c.png' },
  ]), '![one](<b.png>) ![two](<c.png>)');
});

test('image migrations preserve a title starting on the next line', () => {
  const text = '![plot](plot(1).png\r\n  "Caption")';
  assert.deepEqual(markdownImageReferences(text), ['plot(1).png']);
  assert.equal(applyImageMigrations(text, [{ source: 'plot(1).png', relativePath: 'a.png' }]), '![plot](<a.png>\r\n  "Caption")');
});
