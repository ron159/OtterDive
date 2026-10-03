export type RegisteredLanguage = {
  id: string;
  extensions?: string[];
  filenames?: string[];
};

export type LanguageEntry = readonly [id: string, label: string, hint: string];

export const PINNED_LANGUAGES: LanguageEntry[] = [
  ["plaintext", "Plain Text", "txt"],
  ["markdown", "Markdown", "md"],
  ["mdx", "MDX", "mdx"],
  ["json", "JSON", "json, jsonc"],
  ["toml", "TOML", "toml"],
  ["yaml", "YAML", "yaml, yml"],
  ["sql", "SQL", "sql"],
  ["powershell", "PowerShell", "ps1"],
  ["javascript", "JavaScript", "js, jsx"],
  ["typescript", "TypeScript", "ts, tsx"],
  ["python", "Python", "py"],
  ["xml", "XML", "xml"],
  ["html", "HTML", "html"],
  ["css", "CSS", "css"],
  ["java", "Java", "java"],
  ["rust", "Rust", "rs"],
];

export function languageWithOverride(
  detectedLanguage: string | null | undefined,
  languageOverride: string | null | undefined,
) {
  return languageOverride || detectedLanguage || "plaintext";
}

const LANGUAGE_BY_FILE_NAME: Record<string, string> = {
  "containerfile": "dockerfile",
  "dockerfile": "dockerfile",
  "gnumakefile": "shell",
  "makefile": "shell",
  ".babelrc": "json",
  ".bowerrc": "json",
  ".eslintrc": "json",
  ".jscsrc": "json",
  ".jshintrc": "json",
  ".prettierrc": "json",
  ".dockerignore": "plaintext",
  ".env": "plaintext",
  ".env.local": "plaintext",
  ".gitignore": "plaintext",
  ".npmrc": "plaintext",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  txt: "plaintext", text: "plaintext", log: "plaintext", csv: "plaintext", tsv: "plaintext",
  md: "markdown", markdown: "markdown", rmd: "markdown", mdx: "mdx",
  json: "json", jsonc: "json", har: "json", toml: "toml", yaml: "yaml", yml: "yaml",
  sql: "sql", mysql: "mysql", pgsql: "pgsql",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", pyw: "python", pyi: "python",
  xml: "xml", xsd: "xml", xsl: "xml", svg: "xml",
  html: "html", htm: "html", xhtml: "html", css: "css", scss: "scss", less: "less",
  java: "java", rs: "rust", go: "go",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp", csx: "csharp", php: "php", phtml: "php", rb: "ruby", rake: "ruby", gemspec: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ksh: "shell", bat: "bat", cmd: "bat",
  ini: "ini", cfg: "ini", conf: "ini", editorconfig: "ini", properties: "ini",
  kt: "kotlin", kts: "kotlin", swift: "swift", scala: "scala", sc: "scala", dart: "dart",
  lua: "lua", pl: "perl", pm: "perl", r: "r", ex: "elixir", exs: "elixir",
  fs: "fsharp", fsi: "fsharp", fsx: "fsharp", clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure",
  coffee: "coffee", graphql: "graphql", gql: "graphql", tf: "hcl", tfvars: "hcl", hcl: "hcl",
  proto: "protobuf", sol: "solidity", sv: "systemverilog", svh: "systemverilog", vb: "vb", vbs: "vb",
  m: "objective-c", mm: "objective-c", pas: "pascal", pp: "pascal", pug: "pug", jade: "pug",
  hbs: "handlebars", handlebars: "handlebars", twig: "twig", liquid: "liquid", ftl: "freemarker2",
  cshtml: "razor", razor: "razor", redis: "redis", rst: "restructuredtext", rq: "sparql", sparql: "sparql",
  tcl: "tcl", wgsl: "wgsl", bicep: "bicep", apex: "apex", cls: "apex", trigger: "apex",
  abap: "abap", azcli: "azcli", cypher: "cypher", cql: "cypher", qs: "qsharp", pq: "powerquery",
  tsp: "typespec", ecl: "ecl", jl: "julia", asm: "mips", s: "mips", mips: "mips",
  mligo: "cameligo", ligo: "cameligo",
};

export function languageFromFilePath(path: string, registeredLanguages: RegisteredLanguage[]) {
  return knownLanguageFromFilePath(path, registeredLanguages) ?? "plaintext";
}

function knownLanguageFromFilePath(path: string, registeredLanguages: RegisteredLanguage[]) {
  const name = fileNameFromPath(path).toLowerCase();
  const exact = LANGUAGE_BY_FILE_NAME[name];
  if (exact) return exact;

  const extension = fileExtension(name);
  const mapped = LANGUAGE_BY_EXTENSION[extension];
  if (mapped) return mapped;

  const extensionWithDot = extension ? `.${extension}` : "";
  const registered = registeredLanguages.find((language) =>
    language.filenames?.some((candidate) => candidate.toLowerCase() === name)
    || language.extensions?.some((candidate) => candidate.toLowerCase() === extensionWithDot)
  );
  return registered?.id;
}

// Only offer a suggestion for unrecognized names. In particular, logs and explicit
// plain-text files must not turn into code merely because they contain snippets.
export function suggestLanguageFromContent(path: string, source: string, registeredLanguages: RegisteredLanguage[]) {
  if (knownLanguageFromFilePath(path, registeredLanguages) || source.length > 256 * 1024) return null;
  const text = source.replace(/^\uFEFF/, "").trim();
  if (!text || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) return null;

  // Strip JSON comments and trailing commas without altering quoted strings.
  const json = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => token.startsWith('"') ? token : " ")
    .replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, (token) => token.startsWith('"') ? token : "");
  if (/^[{[]/.test(json.trimStart())) {
    try {
      const value: unknown = JSON.parse(json);
      if (value && typeof value === "object") return "json";
    } catch { /* Other formats may also start with a bracket. */ }
  }

  if (/^(?:<!doctype\s+html\b|<html\b)/i.test(text)
    || /^<(?:head|body|div|section|article|p|table|form)\b[\s\S]*<\/(?:head|body|div|section|article|p|table|form)>$/i.test(text)) return "html";
  if (/^<\?xml\s/i.test(text)
    || /^<([\w:.-]+)\b[^>]*>[\s\S]*<\/\1\s*>$/.test(text)
    || /^<[\w:.-]+\b[^>]*\/\s*>$/.test(text)) return "xml";

  const shebang = text.split(/\r?\n/, 1)[0];
  if (/^#!.*\bpython[\d.]*\b/.test(shebang)) return "python";
  if (/^#!.*\b(?:ba|z|fi|k)?sh\b/.test(shebang)) return "shell";
  if (/^#!.*\b(?:node|nodejs|deno|bun)\b/.test(shebang)) return "javascript";
  if (/^FROM\s+\S+/im.test(text) && /^(?:RUN|COPY|ADD|WORKDIR|CMD|ENTRYPOINT|ENV)\s+\S+/m.test(text)) return "dockerfile";
  if (/^(?:async\s+)?def\s+\w+\([^\n]*\)\s*(?:->[^\n]+)?:\s*\n[ \t]+\S/m.test(text)
    || /^class\s+\w+(?:\([^\n]*\))?:\s*\n[ \t]+\S/m.test(text)) return "python";
  if (/^(?:export\s+)?(?:interface\s+\w+(?:\s+extends\s+\w+)?\s*\{|type\s+\w+\s*=)/m.test(text)
    || /^(?:export\s+)?(?:const|let)\s+\w+\s*:\s*[\w[\]<>| ]+\s*=/m.test(text)) return "typescript";
  if (/^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^\n]*\)\s*\{/m.test(text)
    || /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*[^\n]+[;}]\s*$/m.test(text)
    || /^import\s+.+\s+from\s+['"][^'"]+['"];?\s*$/m.test(text)) return "javascript";
  const sql = text.replace(/^(?:\s*--[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/)+/, "").trim();
  if (/^(?:SELECT\s+[\s\S]+\sFROM\s+\S+|INSERT\s+INTO\s+\S+\s*[\s\S]*\bVALUES\b|UPDATE\s+\S+\s+SET\s+|DELETE\s+FROM\s+\S+|CREATE\s+TABLE\s+\S+\s*\()/i.test(sql)
    && /;\s*$/.test(sql)) return "sql";
  if (/^[.#]?[a-zA-Z][\w\s.#,:>+~[\]="'-]*\s*\{\s*[\w-]+\s*:[^{}]+;?\s*\}\s*$/.test(text)) return "css";

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[#;]/.test(line));
  const assignments = lines.filter((line) => /^[\w.-]+\s*=\s*\S/.test(line));
  const sections = lines.filter((line) => /^\[\[?[\w."' -]+\]\]?$/.test(line));
  if (assignments.length >= 1 && sections.length >= 1 && assignments.length + sections.length === lines.length) {
    return assignments.every((line) => /^[\w.-]+\s*=\s*(?:["'[{]|true\b|false\b|[+-]?\d)/.test(line)) ? "toml" : "ini";
  }
  if (lines.length >= 2 && lines.filter((line) => /^(?:-\s+)?[\w.-]+:(?:[ \t]+\S.*)?$/.test(line)).length >= 2
    && lines.every((line) => /^(?:---|\.\.\.|-\s+\S.*|[\w.-]+:(?:[ \t]+\S.*)?)$/.test(line))) return "yaml";
  if (/^#{1,6}\s+\S/m.test(text)
    && (/^(?:[-*+]\s+\S|\d+\.\s+\S|```\w*)/m.test(text) || /\[[^\]\n]+\]\([^)\n]+\)/.test(text))) return "markdown";
  return null;
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function fileExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1) : "";
}
