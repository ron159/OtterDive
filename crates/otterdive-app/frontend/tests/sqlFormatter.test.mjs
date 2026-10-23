import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { format } from "sql-formatter";

const source = fs.readFileSync(new URL("../src/sqlFormatterWorker.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("sqlFormatterWorker.ts", source, ts.ScriptTarget.Latest, true);
const body = ast.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
  .map(node => node.getText(ast)).join("\n");
let receive;
let response;
const context = vm.createContext({ format, self: {
  addEventListener(_name, handler) { receive = handler; },
  postMessage(value) { response = value; },
} });
vm.runInContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
function formatSql(source) {
  receive({ data: { id: 1, source, tabSize: 2, useTabs: false } });
  assert.equal(response.error, undefined);
  return response.text;
}

test("SQL formatting keeps fields after a SELECT line comment outside the comment", () => {
  const output = formatSql("SELECT -- keep this comment\n name, age FROM users;");
  assert.match(output, /-- keep this comment\n\s+name,/);
  assert.doesNotMatch(output, /-- keep this comment[^\n]*name/);
});

test("SQL formatting preserves the bytes of multiline strings and quoted identifiers", () => {
  for (const literal of [
    "'before\n\n\nafter'", "'before\nSELECT\nafter'", "'it''s\nSELECT\nafter'",
    '"before\nSELECT\nafter"', '`before\nSELECT\nafter`',
  ]) assert.ok(formatSql(`SELECT ${literal} AS message;`).includes(literal), literal);
});

test("SQL compaction leaves the formatter's multiline block comments intact", () => {
  const comment = "/* explanation\nSELECT\nthis is a comment\n\n\nend */";
  const sql = `SELECT ${comment} value FROM sample;`;
  assert.equal(formatSql(sql), format(sql, { keywordCase: "upper", expressionWidth: 220 }));
});

test("ordinary SQL retains compact projection lists and short CASE expressions", () => {
  assert.equal(formatSql("select name, age from users where age > 18;"), "SELECT name, age\nFROM users\nWHERE age > 18;");
  assert.match(formatSql("select MAX(case when active = 1 then 1 else 0 end) from users;"), /MAX\(CASE WHEN active = 1 THEN 1 ELSE 0 END\)/);
});
