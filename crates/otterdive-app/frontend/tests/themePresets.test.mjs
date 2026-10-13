import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/themePresets.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const themes = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const mainAst = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true);

function themeHarness() {
  const calls = { palettes: 0, editors: [], markdown: [], saves: 0 };
  const context = {
    ...themes,
    state: { darkMode: true, themePreference: "system", themeOverrides: { light: {}, dark: {} }, workbench: { highContrast: false }, fontSize: 14 },
    SYSTEM_THEME_QUERY: { matches: true },
    syncDocumentThemeState() {}, applyThemePalette() { calls.palettes++; }, defineThemes() {},
    monaco: { editor: { setTheme: (name) => calls.editors.push(name) } },
    markdownEditor: { updateAppearance: (dark) => calls.markdown.push(dark) },
    resolveEditorFontStack: () => "monospace", isMarkdownPreviewEnabled: () => false,
    setThemeButton() {}, renderSettingsMenu() {}, scheduleSessionSave() { calls.saves++; },
  };
  vm.createContext(context);
  for (const name of ["currentThemeMode", "resolvedThemePalette", "setThemePreset", "setThemeColor", "resetCurrentThemeColors", "applyResolvedTheme", "handleSystemThemeChange"]) {
    const fn = mainAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, `${name} is part of the live theme flow`);
    vm.runInContext(ts.transpileModule(fn.getText(mainAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  }
  return { context, calls };
}

test("each preset has readable text and a readable accent in its editor", () => {
  const ids = new Set();
  for (const preset of themes.THEME_PRESETS) {
    assert.ok(!ids.has(preset.id));
    ids.add(preset.id);
    for (const color of Object.values(preset.palette)) assert.match(color, /^#[0-9A-F]{6}$/);
    for (const key of ["background", "surface", "input", "editor"]) {
      assert.ok(contrast(preset.palette.text, preset.palette[key]) >= 4.5, `${preset.id}: text on ${key}`);
    }
    assert.ok(contrast(preset.palette.accent, preset.palette.editor) >= 4.5, `${preset.id}: accent on editor`);
  }
});

test("applying a preset updates the editor and Markdown while preserving the other mode and system preference", () => {
  const { context, calls } = themeHarness();
  context.state.themeOverrides.light = { accent: "#0969DA" };
  context.setThemePreset("dracula");
  assert.equal(context.state.themePreference, "system");
  assert.deepEqual(context.state.themeOverrides.light, { accent: "#0969DA" });
  assert.equal(context.resolvedThemePalette("dark").editor, "#282A36");
  assert.equal(calls.editors.at(-1), "otterdive-dark");
  assert.equal(calls.markdown.at(-1), true);
  assert.equal(calls.saves, 1);
  assert.notEqual(context.state.themeOverrides.dark, themes.THEME_PRESETS.find((preset) => preset.id === "dracula").palette);
});

test("system appearance changes select the saved palette for each mode", () => {
  const { context, calls } = themeHarness();
  context.setThemePreset("catppuccin-mocha");
  context.SYSTEM_THEME_QUERY.matches = false;
  context.handleSystemThemeChange();
  context.setThemePreset("catppuccin-latte");
  assert.equal(context.resolvedThemePalette(context.currentThemeMode()).editor, "#EFF1F5");
  context.SYSTEM_THEME_QUERY.matches = true;
  context.handleSystemThemeChange();
  assert.equal(context.resolvedThemePalette(context.currentThemeMode()).editor, "#1E1E2E");
  assert.equal(calls.editors.at(-1), "otterdive-dark");
  context.state.themePreference = "dark";
  context.SYSTEM_THEME_QUERY.matches = false;
  context.handleSystemThemeChange();
  assert.equal(context.state.darkMode, true);
});

test("both presets survive the existing session JSON format, customization, and current-mode reset", () => {
  const { context } = themeHarness();
  context.setThemePreset("github-dark");
  context.state.darkMode = false;
  context.setThemePreset("github-light");
  const snapshot = JSON.parse(JSON.stringify({ themeOverrides: context.state.themeOverrides }));
  context.state.themeOverrides = themes.normalizeThemeOverrides(snapshot.themeOverrides);
  assert.equal(themes.matchingThemePreset("light", context.resolvedThemePalette("light")).id, "github-light");
  assert.equal(themes.matchingThemePreset("dark", context.resolvedThemePalette("dark")).id, "github-dark");
  context.setThemeColor("accent", "#123abc");
  assert.equal(context.resolvedThemePalette("light").accent, "#123ABC");
  assert.equal(themes.matchingThemePreset("light", context.resolvedThemePalette("light")), undefined);
  context.resetCurrentThemeColors();
  assert.equal(Object.keys(context.state.themeOverrides.light).length, 0);
  assert.equal(themes.matchingThemePreset("light", context.resolvedThemePalette("light")).id, "default-light");
  assert.equal(themes.matchingThemePreset("dark", context.resolvedThemePalette("dark")).id, "github-dark");
});

test("unknown or wrong-mode presets cannot modify colors; high-contrast editor remains active", () => {
  const { context, calls } = themeHarness();
  context.setThemePreset("unknown");
  context.setThemePreset("github-light");
  assert.equal(calls.saves, 0);
  context.state.workbench.highContrast = true;
  context.setThemePreset("one-dark-pro");
  assert.equal(calls.editors.at(-1), "hc-black");
  context.setThemePreset("default-dark");
  assert.equal(Object.keys(context.state.themeOverrides.dark).length, 0);
});

test("old or malformed session colors are safely normalized", () => {
  for (const value of [null, false, [], "dark"]) {
    assert.deepEqual(themes.normalizeThemeOverrides(value), { light: {}, dark: {} });
  }
  assert.deepEqual(themes.normalizeThemeOverrides({
    light: { accent: "#aabbcc", text: "red", surface: "#fff", unknown: "#ABCDEF" },
    dark: ["#FFFFFF"],
  }), { light: { accent: "#AABBCC" }, dark: {} });
});

test("editor selections and line highlights follow each custom palette", () => {
  for (const preset of themes.THEME_PRESETS) {
    const colors = themes.customEditorThemeColors(preset.palette);
    for (const color of Object.values(colors)) assert.match(color, /^#[0-9A-F]{6}([0-9A-F]{2})?$/);
    assert.ok(contrast(preset.palette.text, colors["editor.lineHighlightBackground"]) >= 4.5, preset.id);
    assert.equal(colors["editorBracketHighlight.foreground1"], preset.palette.accent);
  }
});

function contrast(left, right) {
  const luminance = (color) => {
    const [r, g, b] = [1, 3, 5].map((offset) => {
      const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
