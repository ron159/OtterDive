export interface WorkbenchPreferences {
  autoSaveMode: "off" | "afterDelay" | "onFocusChange";
  recoveryEnabled: boolean;
  historyEnabled: boolean;
  retentionDays: number;
  historyEntries: number;
  focusMode: boolean;
  typewriterMode: boolean;
  defaultReading: boolean;
  lineHeight: number;
  paragraphSpacing: number;
  spellcheckEnabled: boolean;
  spellcheckLanguage: string;
  markdownFootnotes: boolean;
  markdownMath: boolean;
  markdownSuperSubScript: boolean;
  markdownFrontMatter: boolean;
  markdownHighlight: boolean;
  markdownAlerts: boolean;
  markdownToc: boolean;
  imageCopy: boolean;
  imageDirectory: string;
  plantumlServer: string;
  paperSize: "A4" | "Letter" | "Legal";
  landscape: boolean;
  marginMm: number;
  pageNumbers: boolean;
  printHeader: string;
  printFooter: string;
  customCss: string;
  highContrast: boolean;
  screenReader: "auto" | "on" | "off";
  syncScroll: boolean;
  includeCodeInStats: boolean;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  autoSaveMode: "afterDelay", recoveryEnabled: true, historyEnabled: true,
  retentionDays: 7, historyEntries: 50,
  focusMode: false, typewriterMode: false, defaultReading: false,
  lineHeight: 1.7, paragraphSpacing: 1, spellcheckEnabled: true, spellcheckLanguage: "",
  markdownFootnotes: true, markdownMath: true, markdownSuperSubScript: true,
  markdownFrontMatter: true, markdownHighlight: true, markdownAlerts: true, markdownToc: true,
  imageCopy: true, imageDirectory: "", plantumlServer: "",
  paperSize: "A4", landscape: false, marginMm: 18, pageNumbers: true,
  printHeader: "", printFooter: "", customCss: "",
  highContrast: false, screenReader: "auto", syncScroll: true, includeCodeInStats: false,
};

export function normalizeWorkbenchPreferences(input: unknown): WorkbenchPreferences {
  const result = { ...DEFAULT_WORKBENCH_PREFERENCES };
  if (!input || typeof input !== "object") return result;
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(result) as Array<keyof WorkbenchPreferences>) {
    if (typeof result[key] === "boolean" && typeof raw[key] === "boolean") {
      (result as unknown as Record<string, unknown>)[key] = raw[key];
    }
  }
  const number = (key: keyof WorkbenchPreferences, min: number, max: number) => {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      (result as unknown as Record<string, unknown>)[key] = Math.min(max, Math.max(min, value));
    }
  };
  number("retentionDays", 1, 365); number("historyEntries", 1, 100);
  number("lineHeight", 1.2, 2.5); number("paragraphSpacing", 0, 3); number("marginMm", 5, 50);
  result.retentionDays = Math.round(result.retentionDays);
  result.historyEntries = Math.round(result.historyEntries);
  for (const key of ["spellcheckLanguage", "imageDirectory", "plantumlServer", "printHeader", "printFooter", "customCss"] as const) {
    if (typeof raw[key] === "string") result[key] = raw[key].slice(0, key === "customCss" ? 32_768 : 2048);
  }
  if (raw.autoSaveMode === "off" || raw.autoSaveMode === "onFocusChange") result.autoSaveMode = raw.autoSaveMode;
  if (raw.paperSize === "Letter" || raw.paperSize === "Legal") result.paperSize = raw.paperSize;
  if (raw.screenReader === "on" || raw.screenReader === "off") result.screenReader = raw.screenReader;
  if (result.plantumlServer && !/^https?:\/\//i.test(result.plantumlServer)) result.plantumlServer = "";
  result.spellcheckLanguage = canonicalSpellcheckLanguage(result.spellcheckLanguage);
  return result;
}

export function markdownExtensionPreferences(preferences: WorkbenchPreferences) {
  return {
    footnote: preferences.markdownFootnotes,
    math: preferences.markdownMath,
    superSubScript: preferences.markdownSuperSubScript,
    frontMatter: preferences.markdownFrontMatter,
    highlight: preferences.markdownHighlight,
    alerts: preferences.markdownAlerts,
    toc: preferences.markdownToc,
  };
}

export function canonicalSpellcheckLanguage(value: string) {
  if (!value.trim()) return "";
  try { return Intl.getCanonicalLocales(value.trim())[0] ?? ""; }
  catch { return ""; }
}

export function spellcheckLanguageSuggestions(preferredLanguages: readonly string[] = []) {
  return [...new Set([...preferredLanguages, "en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "pt-BR", "it-IT"]
    .map(canonicalSpellcheckLanguage).filter(Boolean))];
}
