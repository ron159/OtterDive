import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveAnalyseEnterAction } from "../src/analyseState.ts";

assert.equal(resolveAnalyseEnterAction(false, true, "search"), "add");
assert.equal(resolveAnalyseEnterAction(false, false, "update"), "add");
assert.equal(resolveAnalyseEnterAction(true, false, "add"), "search");
assert.equal(resolveAnalyseEnterAction(true, true, "search"), "search");
assert.equal(resolveAnalyseEnterAction(true, true, "update"), "update");
assert.equal(resolveAnalyseEnterAction(true, true, "add"), "add");

const panelSource = fs.readFileSync(new URL("../src/analysePanel.ts", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(panelSource, /data-analyse-role="all-open-files"/);
assert.match(panelSource, /sourceDocumentId = documentSnapshot\.id/);
assert.match(panelSource, /--analyse-pattern-background/);
assert.match(panelSource, /runButtonContent\(running\)/);
assert.match(mainSource, /getDocuments: \(\) => state\.documents\.map/);
assert.match(stylesSource, /button\.analyse-run-button\.primary:hover:not\(:disabled\)[^{]*\{[^}]*color: #fff;[^}]*background: var\(--text\);/s);
assert.match(stylesSource, /\.analyse-panel-head \.analyse-run-button > span[^{]*\{[^}]*color: #fff !important;/s);
assert.match(stylesSource, /\.analyse-profile-bar button,[^{]*\.analyse-profile-bar select\s*\{[^}]*font-size: 12px;/s);
assert.match(stylesSource, /\.analyse-panel button\s*\{[^}]*font-size: 12px;/s);
assert.match(stylesSource, /\.analyse-panel select\s*\{[^}]*font-size: 12px;/s);
assert.match(stylesSource, /\.analyse-actions button\s*\{[^}]*font-size: 12px;/s);
assert.match(stylesSource, /\.analyse-result-find select,[^{]*\.analyse-result-find button\s*\{[^}]*font-size: 12px;/s);
assert.match(stylesSource, /\.analyse-result-actions button\s*\{[^}]*font-size: 12px;/s);
assert.match(
  stylesSource,
  /\.analyse-draft::-webkit-scrollbar-thumb,[^{]*\.analyse-patterns::-webkit-scrollbar-thumb,[^{]*\.analyse-result-actions::-webkit-scrollbar-thumb\s*\{[^}]*border-radius: 0;/s,
);
assert.match(
  stylesSource,
  /\.analyse-result-editor \.monaco-scrollable-element > \.scrollbar > \.slider\s*\{[^}]*border-radius: 0 !important;/s,
);
assert.match(panelSource, /element\("result-editor"\)\.addEventListener\("wheel", handleResultWheelZoom/);
assert.match(panelSource, /setResultFontSize\(currentFontSize \+ \(event\.deltaY < 0 \? 1 : -1\)\)/);
assert.match(panelSource, /resultSelectionDecorations\.set\(selections\.map/);
assert.match(stylesSource, /\.analyse-result-editor \.monaco-editor \.selected-text[^{]*\{[^}]*background: #2563eb !important;[^}]*box-shadow:/s);
assert.match(stylesSource, /span\.analyse-result-selected-text[^{]*\{[^}]*color: #fff !important;[^}]*background: #2563eb !important;/s);

console.log("Analyse state and multi-document UI checks passed.");
