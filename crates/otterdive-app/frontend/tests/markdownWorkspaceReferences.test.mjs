import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ["markdownPaths", "markdownLinkTools", "markdownWorkspaceReferences"].map(file => {
  const text = fs.readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
  return ts.transpileModule(text.replace(/^import .*;$/gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/^export /gm, "").replace(/^\{\};$/gm, "");
}).join("\n");

function fixture(directory, readText, locate, files = {}) {
  const calls = [];
  const context = vm.createContext({
    URL, document: { createElement: () => ({ set innerHTML(text) { this.content = { querySelectorAll: () => text.split(",").map(id => ({ id })) }; } }) },
    async invoke(command, args) {
      calls.push(command);
      if (command === "list_markdown_reference_directory") return { warnings: [], excluded: 0, limited: false, ...directory(args.path) };
      if (command === "markdown_reference_locations") return { items: [], limited: false, ...locate(args.text) };
      if (command === "file_revisions") return args.paths.map(path => ({ path, revision: files[path] ?? "missing", error: null }));
      throw Error(command);
    },
  });
  vm.runInContext(source, context);
  return { calls, context, scan: (root, controller = new AbortController(), progress = () => {}) =>
    context.scanMarkdownWorkspace({ root, includeHidden: false, skipDirs: "vendor", readText, renderHtml: s => s }, controller.signal, progress) };
}

test("workspace checks and per-section backlinks share results across drive case, encoded names and repeated uses", async () => {
  const root = "C:\\Work", src = root + "\\docs\\src.md", target = root + "\\A B.md";
  const href = "../A%20B.md#part-1";
  const entries = [href, href, "../A%20B.md#missing", "missing.png"];
  const { scan, context, calls } = fixture(path => path === root ? { files: [target], directories: [root + "\\docs"] } : { files: [src], directories: [] },
    path => ({ text: path === src ? "links" : "part,part-1" }),
    text => ({ items: text === "links" ? entries.map((href, i) => ({ href, line: i + 2, column: 4 })) : [] }),
    { [target]: "ok" });
  const report = await scan(root);
  assert.equal(report.scanned, 2);
  assert.equal(report.references.filter(row => row.reason).length, 2);
  const callCount = calls.length;
  assert.equal(context.backlinks(report, "c:/work/a b.md").length, 3);
  assert.deepEqual(Array.from(context.backlinks(report, target, "part-1"), row => [row.source, row.line, row.column]),
    [[src, 2, 4], [src, 3, 4]]);
  assert.equal(calls.length, callCount);
});

test("directory errors, skipped sources, exclusion counts and limits survive into the report", async () => {
  const { scan } = fixture(path => {
    if (path !== "/qa") throw Error("denied");
    return { directories: ["/qa/blocked"], files: ["large.md", "bad.md", "ok.md"], excluded: 2, limited: true };
  }, path => {
    if (path === "bad.md") throw Error("cannot read");
    return { text: "", warning: path === "large.md" ? "超过 1 MiB" : undefined };
  }, () => ({ limited: true }));
  const report = await scan("/qa");
  assert.equal(report.scanned, 1);
  assert.equal(report.excluded, 2);
  assert.equal(report.limited, true);
  for (const reason of ["denied", "cannot read", "1 MiB", "8192", "500"]) assert.ok(report.warnings.some(w => w.includes(reason)));
});

test("cancelling keeps completed files and stops enumerating or reading remaining sources", async () => {
  const controller = new AbortController(), paths = [];
  const { scan } = fixture(() => ({ directories: ["unvisited"], files: ["one", "two"] }),
    path => { paths.push(path); return { text: "ok" }; }, () => ({}));
  const report = await scan("/qa", controller, () => controller.abort());
  assert.deepEqual(paths, ["one"]);
  assert.equal(report.scanned, 1);
  assert.equal(report.cancelled, true);
});

test("cancelling returns immediately while a file read is still outstanding", async () => {
  const controller = new AbortController();
  let started, finish;
  const waiting = new Promise(resolve => { started = resolve; });
  const { scan, calls } = fixture(() => ({ directories: [], files: ["slow.md"] }), () => {
    started();
    return new Promise(resolve => { finish = resolve; });
  }, () => ({}));
  const outcome = scan("/qa", controller);
  await waiting;
  controller.abort();
  const report = await outcome;
  assert.equal(report.cancelled, true);
  finish({ text: "late" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.includes("markdown_reference_locations"), false);
});

test("UNC share roots are case insensitive and POSIX file names remain case sensitive", async () => {
  for (const [root, source, path, compare, expected] of [
    [String.raw`\\SERVER\Docs`, String.raw`\\SERVER\Docs\sub\src.md`, String.raw`..\A.md`, "//server/docs/a.md", 1],
    ["/notes", "/notes/sub/src.md", "../A.md", "/notes/a.md", 0],
  ]) {
    const { scan, context } = fixture(() => ({ directories: [], files: [source] }),
      () => ({ text: "hello" }), () => ({ items: [{ href: path, line: 1, column: 1 }] }));
    const report = await scan(root);
    assert.equal(context.backlinks(report, compare).length, expected);
  }
});

test("a local workspace records foreign file URL shares as skipped without a filesystem probe", async () => {
  const { scan, calls } = fixture(() => ({ directories: [], files: ["/qa/a.md"] }),
    () => ({ text: "" }), () => ({ items: [{ href: "file://host/share/a.md#hello", line: 1, column: 1 }] }));
  const report = await scan("/qa");
  assert.match(report.references[0].reason, /已跳过.*网络共享/);
  assert.equal(calls.includes("file_revisions"), false);
});
