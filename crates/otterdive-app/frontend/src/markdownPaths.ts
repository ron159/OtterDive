function decodePath(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isWindowsPath(path: string) { return /^[a-z]:[\\/]|^[\\/]{2}[^/\\]/i.test(path); }

/** Normalize filesystem paths without changing POSIX case or treating a drive as a URI scheme. */
export function normalizeResourcePath(path: string): string {
  const windows = isWindowsPath(path);
  const value = path.replace(/\\/g, "/");
  const root = /^[a-z]:\//i.exec(value)?.[0] ?? (value.startsWith("//") ? "//" : value.startsWith("/") ? "/" : "");
  const parts: string[] = [];
  // UNC host/share is the root; parent traversal must not remove it.
  const floor = root === "//" ? 2 : 0;
  for (const part of value.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > floor && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  const normalized = root + parts.join("/");
  return windows ? normalized.replace(/\//g, "\\") : normalized;
}

export function resolveMarkdownResource(source: string, documentPath?: string | null, workspaceRoot?: string | null): string {
  let value = source.trim().replace(/^<|>$/g, "");
  if (!value) return "";
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      value = (url.hostname ? `//${url.hostname}` : "") + decodePath(url.pathname);
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    } catch { return ""; }
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return "";
    value = decodePath(value);
  }
  if (/^(?:[a-z]:[\\/]|[\\/])/i.test(value)) return normalizeResourcePath(value);
  const base = documentPath ? documentPath.replace(/[\\/][^\\/]*$/, "") : workspaceRoot;
  return base ? normalizeResourcePath(`${base}/${value}`) : "";
}

export function relativeMarkdownResource(fromDirectory: string, targetPath: string): string {
  const from = normalizeResourcePath(fromDirectory).replace(/\\/g, "/");
  const target = normalizeResourcePath(targetPath).replace(/\\/g, "/");
  const windows = isWindowsPath(fromDirectory) && isWindowsPath(targetPath);
  const same = (a: string, b: string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  const root = (path: string) => /^[a-z]:/i.exec(path)?.[0] ?? (path.startsWith("//") ? path.split("/").slice(0, 4).join("/") : path.startsWith("/") ? "/" : "");
  if (!same(root(from), root(target))) return target;
  const a = from.split("/").filter(Boolean), b = target.split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && same(a[common], b[common])) common++;
  return [...Array(a.length - common).fill(".."), ...b.slice(common)].join("/") || b.at(-1) || ".";
}

export function splitMarkdownLink(href: string) {
  const index = href.indexOf("#");
  return { path: (index < 0 ? href : href.slice(0, index)).split("?", 1)[0], anchor: index < 0 ? "" : decodePath(href.slice(index + 1)) };
}
