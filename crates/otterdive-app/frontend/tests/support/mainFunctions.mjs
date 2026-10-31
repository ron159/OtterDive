import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);

// Keep the production function bodies and isolate only their external boundaries.
export function mainFunctions(names) {
  const selected = new Set(names);
  const functions = ast.statements.filter(node =>
    ts.isFunctionDeclaration(node) && selected.has(node.name?.text));
  const found = new Set(functions.map(node => node.name.text));
  for (const name of selected) {
    if (!found.has(name)) throw new Error(`Production function not found: ${name}`);
  }
  return ts.transpileModule(functions.map(node => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
