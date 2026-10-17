import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "selectSettingsSection", "renderSettingsMenu", "refreshSystemIntegrationStatus",
  "refreshShellIntegrationStatus", "refreshDefaultAppCandidateStatus", "syncSystemIntegrationPreferences",
  "toggleShellIntegration", "toggleDefaultAppCandidate", "integrationErrorStatus", "integrationErrorMessage",
]);
const code = ast.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.has(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ["isTauriRuntime", "isWindowsRuntime"].includes(declaration.name.getText(ast))),
).map(node => node.getText(ast)).join("\n");
const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const noop = () => {};

function element(dataset = {}) {
  const classes = new Set();
  return {
    dataset, value: "", textContent: "",
    classList: {
      contains: name => classes.has(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    setAttribute: noop,
    querySelector: () => ({ scrollTo: noop }),
  };
}

function harness(userAgent, native = true) {
  const nav = ["appearance", "system", "about"].map(section => element({ settingsSection: section }));
  const panels = ["appearance", "system", "about"].map(section => element({ settingsPanel: section }));
  nav[1].classList.toggle("hidden", true);
  panels[1].classList.toggle("hidden", true);
  const elements = new Map();
  const commands = [];
  const status = { supported: true, enabled: false, label: "Windows integration", detail: "Available" };
  const state = {
    settingsSection: "appearance", workbench: {}, shellIntegration: { ...status }, defaultAppCandidate: { ...status },
    shellIntegrationLoaded: true, defaultAppCandidateLoaded: true, contextMenuEnabled: true, defaultAppCandidateEnabled: true,
  };
  const context = {
    state,
    window: { navigator: { userAgent }, ...(native ? { __TAURI_INTERNALS__: {} } : {}) },
    document: { querySelectorAll: selector => selector === "[data-settings-section]" ? nav : panels },
    $: id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    invoke: async command => { commands.push(command); return { ...status }; },
    syncWorkbenchSettings: noop, renderThemePresets: noop, resolvedThemePalette: () => ({}), currentThemeMode: noop,
    THEME_COLOR_CONTROLS: {}, FONT_MODE_LABELS: {}, SHELL_FONT_LABELS: {}, EDITOR_FONT_LABELS: {},
    setFontDropdownLabel: noop, setFontMenuValue: noop, setFontInputValue: noop, setSegmentedValue: noop,
    renderAppUpdateStatus: noop, keymapProfileDetail: () => "", renderSystemIntegrationControl: noop,
    renderKeybindingSettings: noop, scheduleSessionSave: noop, log: noop,
  };
  vm.createContext(context);
  vm.runInContext(js, context);
  return { context, state, nav, panels, commands };
}

for (const [platform, userAgent] of [
  ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
  ["Linux", "Mozilla/5.0 (X11; Linux x86_64)"],
]) {
  test(`${platform} hides system integration and rejects navigation into it`, () => {
    const h = harness(userAgent);
    h.context.renderSettingsMenu();
    assert.equal(h.nav[1].classList.contains("hidden"), true);
    assert.equal(h.panels[1].classList.contains("hidden"), true);
    h.context.selectSettingsSection("system");
    assert.equal(h.state.settingsSection, "appearance");
    h.state.settingsSection = "system";
    h.context.renderSettingsMenu();
    assert.equal(h.state.settingsSection, "appearance");
    assert.equal(h.panels[0].classList.contains("active"), true);
  });

  test(`${platform} never reads or changes Windows integration`, async () => {
    const h = harness(userAgent);
    await h.context.refreshSystemIntegrationStatus();
    await h.context.syncSystemIntegrationPreferences();
    await h.context.toggleShellIntegration();
    await h.context.toggleDefaultAppCandidate();
    assert.deepEqual(h.commands, []);
  });
}

test("Windows retains its system integration panel, status reads and preference synchronization", async () => {
  const h = harness("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  h.context.renderSettingsMenu();
  assert.equal(h.nav[1].classList.contains("hidden"), false);
  assert.equal(h.panels[1].classList.contains("hidden"), false);
  h.context.selectSettingsSection("system");
  assert.equal(h.state.settingsSection, "system");
  assert.equal(h.panels[1].classList.contains("active"), true);
  await h.context.syncSystemIntegrationPreferences();
  await h.context.toggleShellIntegration();
  await h.context.toggleDefaultAppCandidate();
  assert.deepEqual(h.commands, [
    "shell_integration_status", "default_app_candidate_status",
    "set_shell_integration", "set_default_app_candidate",
    "set_shell_integration", "set_default_app_candidate",
  ]);
});

test("the browser preview does not expose Windows integration", async () => {
  const h = harness("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", false);
  h.context.renderSettingsMenu();
  assert.equal(h.nav[1].classList.contains("hidden"), true);
  await h.context.syncSystemIntegrationPreferences();
  assert.deepEqual(h.commands, []);
});
