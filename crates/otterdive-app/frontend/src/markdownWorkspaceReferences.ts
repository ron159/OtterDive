import { invoke } from "@tauri-apps/api/core";
import { comparablePath, markdownReferenceChecker, readLinkTarget } from "./markdownLinkTools";

export type ReferenceLocation = { href: string; line: number; column: number };
export type WorkspaceReference = ReferenceLocation & { source: string; resolved: string; anchor: string; reason: string };
type Directory = { directories: string[]; files: string[]; warnings: string[]; excluded: number; limited: boolean };
export type ReferenceScan = {
  root: string; references: WorkspaceReference[]; warnings: string[]; warningCount: number;
  scanned: number; excluded: number; cancelled: boolean; limited: boolean;
};
export type ReferenceScanOptions = {
  root: string; includeHidden: boolean; skipDirs: string;
  readText: typeof readLinkTarget;
  renderHtml: (source: string) => string | Promise<string>;
};

export function backlinks(report: ReferenceScan, target: string, anchor = "") {
  const key = comparablePath(target);
  return report.references.filter(ref => comparablePath(ref.resolved) === key && (!anchor || ref.anchor === anchor));
}

// A single filesystem request can stall (for example on a disconnected volume).
// Stop waiting immediately and let its bounded native operation finish independently.
function scanStep<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const stop = () => resolve(undefined);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export async function scanMarkdownWorkspace(options: ReferenceScanOptions, signal: AbortSignal,
  progress: (scanned: number) => void): Promise<ReferenceScan> {
  const { root, includeHidden, skipDirs, readText } = options;
  const report: ReferenceScan = { root, references: [], warnings: [], warningCount: 0,
    scanned: 0, excluded: 0, cancelled: false, limited: false };
  const check = markdownReferenceChecker(options.renderHtml, readText, root);
  const directories = [root];
  let directoryCount = 1, fileCount = 0, retainedChars = 0;
  function warn(message: string) {
    report.warningCount++;
    if (report.warnings.length < 100) report.warnings.push(message);
  }
  function limit(message: string) { report.limited = true; warn(message); }

  traversal: while (directories.length && !signal.aborted) {
    const path = directories.pop()!;
    let directory: Directory | undefined;
    try { directory = await scanStep(invoke<Directory>("list_markdown_reference_directory", { path, includeHidden, skipDirs }), signal); }
    catch (error) { warn(`${path}：无法读取目录：${String(error)}`); continue; }
    if (!directory || signal.aborted) break;
    report.excluded += directory.excluded;
    for (const message of directory.warnings) warn(`${path}：读取目录项失败：${message}`);
    if (directory.limited) limit(`${path}：目录超过 8192 项，已跳过其余目录项`);
    const room = 2048 - directoryCount;
    if (directory.directories.length > room) limit(`${path}：工作区超过 2048 个目录，部分子目录已跳过`);
    const children = directory.directories.slice(0, room);
    directoryCount += children.length;
    directories.push(...children.reverse());
    for (const source of directory.files) {
      if (signal.aborted) break traversal;
      if (++fileCount > 1000) { limit("文档数超过 1000，已停止扫描"); break traversal; }
      try {
        const document = await scanStep(Promise.resolve(readText(source)), signal);
        if (!document || signal.aborted) break traversal;
        if (document.warning) { warn(`${source}：${document.warning}`); continue; }
        const found = await scanStep(invoke<{ items: ReferenceLocation[]; limited: boolean }>("markdown_reference_locations", { text: document.text }), signal);
        if (!found || signal.aborted) break traversal;
        if (found.limited) limit(`${source}：本篇引用超过 500 处或目标地址超过 256 KiB，已跳过其余引用`);
        const checked = await scanStep(check(found.items, { text: document.text, path: source }, root, signal), signal);
        if (!checked) break traversal;
        for (const reference of checked) {
          retainedChars += source.length + reference.href.length + reference.resolved.length + reference.reason.length;
          if (report.references.length >= 20_000 || retainedChars > 4 * 1024 * 1024) {
            limit("工作区引用超过 20000 处或结果文本超过 4M 字符，已停止扫描");
            break traversal;
          }
          report.references.push({ ...reference, source });
        }
        if (signal.aborted) break traversal;
        progress(++report.scanned);
      } catch (error) { warn(`${source}：读取或解析失败：${String(error)}`); }
    }
  }
  report.cancelled = signal.aborted;
  return report;
}
