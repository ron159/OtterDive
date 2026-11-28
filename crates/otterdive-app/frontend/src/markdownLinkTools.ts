import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor/editor";
import { normalizeResourcePath, relativeMarkdownResource, resolveMarkdownResource, splitMarkdownLink } from "./markdownPaths";
import { headingLinkSuggestions, markdownLinkCompletionContext } from "./markdownLinkSuggestions";
import type { FileChunk } from "./logViewerState";

type LinkDocument = { path?: string | null; text: string };
type RenderHtml = (text: string) => string | Promise<string>;
export type MarkdownLinkIssue = { href: string; label: string; reason: string };
export type MarkdownLinkCompletionOptions = {
  getDocument: (model: monaco.editor.ITextModel) => LinkDocument | null;
  getFiles: () => string[];
  getWorkspaceRoot: () => string | null | undefined;
  renderHtml: RenderHtml;
};

export function comparablePath(path: string) {
  const normalized = normalizeResourcePath(path);
  return /^[a-z]:[\\/]|^[\\/]{2}/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function parseHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}
function documentDirectory(path: string) { return path.replace(/[\\/][^\\/]*$/, "") || "/"; }
function isExternalLink(href: string) {
  return /^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)
    || href.startsWith("//");
}

export async function readLinkTarget(path: string): Promise<{ text: string; warning?: string }> {
  const chunk = await invoke<FileChunk>("read_file_chunk", { request: { path, offset: 0, limit: 1024 * 1024, tail: false, encoding: "auto" } });
  return { text: chunk.text, warning: chunk.warning || (chunk.hasMore || chunk.size > 1024 * 1024 ? "文件超过 1 MiB，已跳过" : chunk.text.includes("\0") ? "已跳过二进制内容" : undefined) };
}

export function registerMarkdownLinkCompletions(options: MarkdownLinkCompletionOptions): monaco.IDisposable {
  const registrations = ["markdown", "mdx"].map(language => monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ["(", "#", "/"],
    async provideCompletionItems(model, position, _context, token) {
      const context = markdownLinkCompletionContext(model.getLineContent(position.lineNumber).slice(0, position.column - 1));
      if (!context) return { suggestions: [] };
      const source = options.getDocument(model);
      if (!source) return { suggestions: [] };
      const version = model.getVersionId();
      const range = new monaco.Range(position.lineNumber, context.start + 1, position.lineNumber, position.column);
      let suggestions: monaco.languages.CompletionItem[] = [];
      if (context.value.includes("#")) {
        const link = splitMarkdownLink(context.value);
        if (isExternalLink(link.path)) return { suggestions: [] };
        const path = link.path ? resolveMarkdownResource(link.path, source.path, options.getWorkspaceRoot()) : source.path;
        let text = source.text;
        if (link.path) {
          if (!path) return { suggestions: [] };
          const opened = monaco.editor.getModels().map(options.getDocument).find(doc => doc?.path && comparablePath(doc.path) === comparablePath(path));
          try {
            if (opened) text = opened.text;
            else {
              const target = await readLinkTarget(path);
              if (target.warning) return { suggestions: [] };
              text = target.text;
            }
          } catch { return { suggestions: [] }; }
        }
        if (text.length > 1024 * 1024) return { suggestions: [] };
        const rendered = parseHtml(await options.renderHtml(text));
        const headings = [...rendered.querySelectorAll<HTMLHeadingElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")]
          .map(heading => ({ id: heading.id, text: heading.textContent ?? "" }));
        suggestions = headingLinkSuggestions(context.value, headings).map(item => ({
          label: item.label, insertText: item.text, detail: item.detail,
          kind: monaco.languages.CompletionItemKind.Reference, range,
        }));
      } else {
        const directory = source.path ? documentDirectory(source.path) : options.getWorkspaceRoot();
        if (!directory || isExternalLink(context.value)) return { suggestions: [] };
        let typed = context.value;
        try { typed = decodeURIComponent(typed); } catch { /* Incomplete escape while typing. */ }
        const needle = typed.toLocaleLowerCase();
        const seen = new Set<string>();
        for (const path of options.getFiles()) {
          const key = comparablePath(path);
          if (seen.has(key)) continue;
          seen.add(key);
          const relative = relativeMarkdownResource(directory, path);
          if (!relative.toLocaleLowerCase().includes(needle)) continue;
          suggestions.push({ label: relative, insertText: relative.split("/").map(encodeURIComponent).join("/"),
            detail: path, kind: monaco.languages.CompletionItemKind.File, range });
          if (suggestions.length >= 200) break;
        }
      }
      if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return { suggestions: [] };
      return { suggestions };
    },
  }));
  return { dispose: () => registrations.forEach(item => item.dispose()) };
}

type Revision = { path: string; revision: string | null; error: string | null };
type ReadText = typeof readLinkTarget;
export type CheckedReference<T> = T & { resolved: string; anchor: string; reason: string };

// A workspace-wide scan may inspect its selected UNC share, but must not initiate
// connections to other network shares named by arbitrary documents.
function shareRoot(key: string) {
  return /^\\\\[^\\]+\\[^\\]+/.exec(key)?.[0];
}

export function markdownReferenceChecker(renderHtml: RenderHtml, readText: ReadText = readLinkTarget, scanRoot?: string) {
  const allowedShare = scanRoot && shareRoot(comparablePath(scanRoot));
  const revisions = new Map<string, Revision>();
  const headings = new Map<string, Set<string> | string>();
  function ids(text: string) {
    return Promise.resolve(renderHtml(text)).then(html =>
      new Set([...parseHtml(html).querySelectorAll<HTMLElement>("[id]")].map(element => element.id)));
  }
  return async function check<T extends { href: string }>(items: T[], source: LinkDocument,
    workspaceRoot?: string | null, signal?: AbortSignal): Promise<CheckedReference<T>[]> {
    const links = items.map(item => {
      const { path, anchor } = splitMarkdownLink(item.href);
      const resolved = path ? resolveMarkdownResource(path, source.path, workspaceRoot) : source.path || "";
      const key = comparablePath(resolved);
      const share = scanRoot && shareRoot(key);
      return { item, path, anchor, resolved, key, skippedShare: Boolean(share && share !== allowedShare) };
    });
    const missingStatus = new Map<string, string>();
    for (const link of links) {
      if (link.path && link.resolved && !link.skippedShare && !revisions.has(link.key)) missingStatus.set(link.key, link.resolved);
    }
    if (missingStatus.size && !signal?.aborted) {
      try {
        const files = await invoke<Revision[]>("file_revisions", { paths: [...missingStatus.values()] });
        for (const file of files) revisions.set(comparablePath(file.path), file);
      } catch (error) {
        for (const [key, path] of missingStatus) revisions.set(key, { path, revision: null, error: String(error) });
      }
    }
    let currentIds: Set<string> | undefined;
    const checked: CheckedReference<T>[] = [];
    for (const { item, path, anchor, resolved, key, skippedShare } of links) {
      if (signal?.aborted) break;
      let reason = "";
      const revision = revisions.get(key);
      if (skippedShare) reason = "已跳过工作区以外的网络共享";
      else if (path && !resolved) reason = "相对链接缺少文档保存位置或工作区目录";
      else if (path && revision?.revision === "missing") reason = "目标文件不存在";
      else if (path && !revision?.revision) reason = `无法检查目标文件：${revision?.error || "没有文件状态"}`;
      else if (anchor) {
        try {
          if (!path || source.path && comparablePath(source.path) === key) {
            currentIds ??= await ids(source.text);
            if (!currentIds.has(anchor)) reason = `未找到文档锚点 #${anchor}`;
          } else if (/\.(?:md|markdown|mdx|rmd)$/i.test(resolved)) {
            let found = headings.get(key);
            if (found === undefined) {
              const target = await readText(resolved);
              if (signal?.aborted) break;
              found = target.warning || await ids(target.text);
              // Bound rendered heading sets independently of the result count.
              if (headings.size >= 32) headings.delete(headings.keys().next().value!);
              headings.set(key, found);
            }
            if (typeof found === "string") reason = found;
            else if (!found.has(anchor)) reason = `目标文档没有锚点 #${anchor}`;
          }
        } catch (error) { reason = `无法检查目标标题：${String(error)}`; }
      }
      checked.push({ ...item, resolved, anchor, reason });
    }
    return checked;
  };
}

/** Inspect local file links, images and anchors; external URLs are never requested. */
export async function checkMarkdownLinks(options: LinkDocument & { workspaceRoot?: string | null; renderHtml: RenderHtml }): Promise<MarkdownLinkIssue[]> {
  const html = await options.renderHtml(options.text);
  const current = parseHtml(html);
  const links = new Map<string, string>();
  for (const [selector, attribute] of [["a[href]", "href"], ["img[src]", "src"]] as const) {
    for (const element of current.querySelectorAll<HTMLElement>(selector)) {
      const href = element.getAttribute(attribute)?.trim();
      if (href && !isExternalLink(href)) links.set(href, element.textContent?.trim() || element.getAttribute("alt") || href);
    }
  }
  const issues: MarkdownLinkIssue[] = [];
  if (links.size > 500) issues.push({ href: "", label: "检查范围", reason: "链接超过 500 个，本次仅检查前 500 个" });
  const selected = [...links].slice(0, 500).map(([href, label]) => ({ href, label }));
  const check = markdownReferenceChecker(text => text === options.text ? html : options.renderHtml(text));
  issues.push(...(await check(selected, options, options.workspaceRoot)).filter(link => link.reason));
  return issues;
}
