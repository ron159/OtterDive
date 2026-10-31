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

assert.match(panelSource, /data-analyse-role="all-open-files"/);
assert.match(panelSource, /sourceDocumentId = documentSnapshot\.id/);
assert.match(panelSource, /--analyse-pattern-background/);
assert.match(panelSource, /runButtonContent\(running\)/);
assert.match(mainSource, /getDocuments: \(\) => state\.documents\.map/);
assert.match(panelSource, /element\("result-editor"\)\.addEventListener\("wheel", handleResultWheelZoom/);
assert.match(panelSource, /setResultFontSize\(currentFontSize \+ \(event\.deltaY < 0 \? 1 : -1\)\)/);
assert.match(panelSource, /resultSelectionDecorations\.set\(selections\.map/);

console.log("Analyse state and multi-document UI checks passed.");
