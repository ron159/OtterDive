import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['markdownImageContentMask', 'markdownImageReferences', 'replaceImageReference', 'applyImageMigrations'];
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
test('image migration finds inline, HTML and reference images but ignores code examples', () => {
  const text = '![real](real.png)\n<img src="html.png">\n![reference][asset]\n[asset]: <ref%20image.png> "title"\n`![code](inline.png)`\n```md\n![example](fenced.png)\n```\n    ![code](indented.png)\n\\![escaped](escaped.png)\n';
  assert.deepEqual([...context.markdownImageReferences(text)], ['real.png', 'html.png', 'ref%20image.png']);
});
test('image rewriting preserves code, escaped syntax, titles and CRLF bytes', () => {
  const source = '![image](a.png "title")\r\n`![example](a.png)`\r\n```md\r\n![example](a.png)\r\n```\r\n\\![literal](a.png)\r\n![ref][id]\r\n[id]: <a.png> "caption"\r\n';
  const changed = context.applyImageMigrations(source, [{ source: 'a.png', relativePath: 'new%20folder/a.png' }]);
  assert.equal(changed, source.replace('![image](a.png', '![image](<new%20folder/a.png>').replace('[id]: <a.png>', '[id]: <new%20folder/a.png>'));
});
