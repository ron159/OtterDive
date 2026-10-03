import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
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

function comparablePath(path: string) {
  const normalized = normalizeResourcePath(path);
  return /^[a-z]:[\\/]|^[\\/]{2}/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function parseHtml(html: string) { return new DOMParser().parseFromString(html, "text/html"); }
function documentDirectory(path: string) { return path.replace(/[\\/][^\\/]*$/, "") || "/"; }
function isExternalLink(href: string) {
  return /^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)
    || href.startsWith("//");
}

async function readLinkTarget(path: string): Promise<{ text: string; warning?: string }> {
  const chunk = await invoke<FileChunk>("read_file_chunk", { request: { path, offset: 0, limit: 1024 * 1024, tail: false, encoding: "auto" } });
  return { text: chunk.text, warning: chunk.warning || (chunk.hasMore ? "目标文档超过 1 MiB，标题检查未完成" : undefined) };
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

/** Inspect local file links and document anchors; external URLs are never requested. */
export async function checkMarkdownLinks(options: LinkDocument & { workspaceRoot?: string | null; renderHtml: RenderHtml }): Promise<MarkdownLinkIssue[]> {
  const current = parseHtml(await options.renderHtml(options.text));
  const currentIds = new Set([...current.querySelectorAll<HTMLElement>("[id]")].map(element => element.id));
  const links = new Map<string, string>();
  for (const anchor of current.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href")?.trim();
    if (href && !isExternalLink(href)) links.set(href, anchor.textContent?.trim() || href);
  }
  const issues: MarkdownLinkIssue[] = [];
  if (links.size > 500) issues.push({ href: "", label: "检查范围", reason: "链接超过 500 个，本次仅检查前 500 个" });
  const selected = [...links].slice(0, 500).map(([href, label]) => {
    const link = splitMarkdownLink(href);
    const path = link.path ? resolveMarkdownResource(link.path, options.path, options.workspaceRoot) : options.path;
    return { href, label, ...link, resolved: path };
  });
  const paths = [...new Set(selected.filter(link => link.path && link.resolved).map(link => link.resolved!))];
  const revisions = paths.length ? await invoke<Array<{ path: string; revision: string | null; error: string | null }>>("file_revisions", { paths }) : [];
  const files = new Map(revisions.map(file => [comparablePath(file.path), file]));
  const idsByPath = new Map<string, Promise<Set<string> | string>>();
  for (const link of selected) {
    let reason = "";
    if (!link.path) {
      if (link.anchor && !currentIds.has(link.anchor)) reason = `未找到文档锚点 #${link.anchor}`;
    } else if (!link.resolved) reason = "相对链接缺少文档保存位置或工作区目录";
    else {
      const file = files.get(comparablePath(link.resolved));
      if (file?.revision === "missing") reason = "目标文件不存在";
      else if (!file?.revision) reason = `无法检查目标文件：${file?.error || "没有文件状态"}`;
      else if (link.anchor && options.path && comparablePath(link.resolved) === comparablePath(options.path)) {
        if (!currentIds.has(link.anchor)) reason = `未找到文档锚点 #${link.anchor}`;
      } else if (link.anchor && /\.(?:md|markdown|mdx)$/i.test(link.resolved)) {
        const key = comparablePath(link.resolved);
        let ids = idsByPath.get(key);
        if (!ids) {
          ids = (async () => {
            try {
              const target = await readLinkTarget(link.resolved!);
              if (target.warning) return target.warning;
              return new Set([...parseHtml(await options.renderHtml(target.text)).querySelectorAll<HTMLElement>("[id]")].map(element => element.id));
            } catch (error) { return `无法检查目标标题：${String(error)}`; }
          })();
          idsByPath.set(key, ids);
        }
        const found = await ids;
        if (typeof found === "string") reason = found;
        else if (!found.has(link.anchor)) reason = `目标文档没有锚点 #${link.anchor}`;
      }
    }
    if (reason) issues.push({ href: link.href, label: link.label, reason });
  }
  return issues;
}
