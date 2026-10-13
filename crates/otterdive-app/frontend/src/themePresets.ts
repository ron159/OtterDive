export type ThemeMode = "light" | "dark";
export type ThemeColorKey = "background" | "surface" | "input" | "editor" | "text" | "accent";
export type ThemePalette = Record<ThemeColorKey, string>;
export type ThemeOverrides = Record<ThemeMode, Partial<ThemePalette>>;

export const DEFAULT_THEME_PALETTES: Record<ThemeMode, ThemePalette> = {
  light: {
    background: "#E8EEF6", surface: "#FFFFFF", input: "#F5F8FC",
    editor: "#FFFFFF", text: "#111827", accent: "#3238D8",
  },
  dark: {
    background: "#121722", surface: "#1D2431", input: "#202838",
    editor: "#151B26", text: "#EDF2FB", accent: "#858BFF",
  },
};

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  mode: ThemeMode;
  palette: ThemePalette;
}

// Workbench palette references, adapted to OtterDive's six editable colors:
// https://github.com/Binaryify/OneDark-Pro/blob/master/themes/OneDark-Pro.json
// https://github.com/dracula/visual-studio-code/blob/master/src/dracula.yml
// https://github.com/primer/github-vscode-theme
// https://catppuccin.com/palette/
export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: "default-light", name: "晨光", description: "OtterDive 默认亮色", mode: "light", palette: DEFAULT_THEME_PALETTES.light },
  { id: "github-light", name: "GitHub Light", description: "清透白底 · 蓝色强调", mode: "light", palette: {
    background: "#F6F8FA", surface: "#FFFFFF", input: "#F6F8FA",
    editor: "#FFFFFF", text: "#1F2328", accent: "#0969DA",
  } },
  { id: "catppuccin-latte", name: "Catppuccin Latte", description: "柔和奶白 · 薰衣草紫", mode: "light", palette: {
    background: "#DCE0E8", surface: "#E6E9EF", input: "#EFF1F5",
    editor: "#EFF1F5", text: "#4C4F69", accent: "#8839EF",
  } },
  { id: "default-dark", name: "夜航", description: "OtterDive 默认深色", mode: "dark", palette: DEFAULT_THEME_PALETTES.dark },
  { id: "one-dark-pro", name: "One Dark Pro", description: "炭灰底色 · 晴空蓝", mode: "dark", palette: {
    background: "#21252B", surface: "#282C34", input: "#2C313A",
    editor: "#282C34", text: "#ABB2BF", accent: "#61AFEF",
  } },
  { id: "dracula", name: "Dracula", description: "深紫灰 · 经典紫色", mode: "dark", palette: {
    background: "#21222C", surface: "#282A36", input: "#343746",
    editor: "#282A36", text: "#F8F8F2", accent: "#BD93F9",
  } },
  { id: "github-dark", name: "GitHub Dark", description: "墨黑底色 · 清晰蓝色", mode: "dark", palette: {
    background: "#010409", surface: "#161B22", input: "#0D1117",
    editor: "#0D1117", text: "#E6EDF3", accent: "#58A6FF",
  } },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", description: "摩卡深色 · 柔和粉紫", mode: "dark", palette: {
    background: "#11111B", surface: "#181825", input: "#313244",
    editor: "#1E1E2E", text: "#CDD6F4", accent: "#CBA6F7",
  } },
];

export function resolveThemePalette(mode: ThemeMode, overrides: ThemeOverrides): ThemePalette {
  return { ...DEFAULT_THEME_PALETTES[mode], ...overrides[mode] };
}

export function matchingThemePreset(mode: ThemeMode, palette: ThemePalette): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.mode === mode
    && (Object.keys(preset.palette) as ThemeColorKey[])
      .every((key) => preset.palette[key] === palette[key].toUpperCase()));
}

export function normalizeThemeColor(value: unknown): string | null {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  return value.toUpperCase();
}

export function normalizeThemeOverrides(value: unknown): ThemeOverrides {
  const normalized: ThemeOverrides = { light: {}, dark: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const mode of ["light", "dark"] as const) {
    const source = (value as Partial<Record<ThemeMode, unknown>>)[mode];
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of Object.keys(DEFAULT_THEME_PALETTES[mode]) as ThemeColorKey[]) {
      const color = normalizeThemeColor((source as Partial<ThemePalette>)[key]);
      if (color) normalized[mode][key] = color;
    }
  }
  return normalized;
}

function mixColor(background: string, foreground: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const base = parseInt(background.slice(offset, offset + 2), 16);
    const top = parseInt(foreground.slice(offset, offset + 2), 16);
    return Math.round(base + (top - base) * amount).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`.toUpperCase();
}

// Monaco requires resolved hex colors rather than the CSS color-mix used by the shell.
export function customEditorThemeColors(palette: ThemePalette): Record<string, string> {
  const selection = mixColor(palette.editor, palette.accent, 0.25);
  return {
    "editorLineNumber.foreground": mixColor(palette.editor, palette.text, 0.58),
    "editor.selectionBackground": selection,
    "editor.inactiveSelectionBackground": mixColor(palette.editor, palette.text, 0.12),
    "editor.selectionHighlightBackground": `${selection}88`,
    "editorBracketMatch.background": `${selection}88`,
    "editorBracketHighlight.foreground1": palette.accent,
    "editor.wordHighlightBackground": `${selection}88`,
    "editor.wordHighlightStrongBackground": `${selection}AA`,
    "editor.wordHighlightTextBackground": `${selection}88`,
    "editor.lineHighlightBackground": mixColor(palette.editor, palette.text, 0.035),
    "editorIndentGuide.background1": mixColor(palette.editor, palette.text, 0.13),
    "editorIndentGuide.activeBackground1": mixColor(palette.editor, palette.text, 0.35),
  };
}
