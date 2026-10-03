import { invoke } from "@tauri-apps/api/core";
import { createMarkdownDiagramExport, type MarkdownDiagramFormat } from "./markdownDiagramExport";

const DIAGRAM_SELECTOR = ".markdown-diagram, .mu-diagram-preview";
const EDITOR_SELECTOR = "#markdownWysiwyg, #markdownPreview";
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

interface DiagramActionHost {
  isNative: () => boolean;
  documentTitle: () => string;
  defaultDirectory: () => string | null | undefined;
  notify: (message: string) => void;
}

export function diagramExportFileName(title: string, format: MarkdownDiagramFormat) {
  const stem = title.trim().replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  return `${stem || "Markdown"}-图表.${format}`;
}

/** Only diagram render containers qualify. Ordinary document images are excluded. */
export function renderedDiagramTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const diagram = target.closest<HTMLElement>(DIAGRAM_SELECTOR);
  if (!diagram?.closest(EDITOR_SELECTOR) || !diagram.querySelector("svg, img")) return null;
  return diagram;
}

export function bindMarkdownDiagramActions(host: DiagramActionHost) {
  const toolbar = document.getElementById("markdownDiagramActions");
  const status = document.getElementById("markdownDiagramExportStatus");
  if (!toolbar || !status) return;
  const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>("button[data-diagram-format]")];
  let selected: HTMLElement | null = null;
  let busy = false;
  let frame = 0;

  const hide = () => {
    if (busy) return;
    if (toolbar.contains(document.activeElement)) selected?.focus({ preventScroll: true });
    toolbar.hidden = true;
    selected = null;
  };
  const position = () => {
    frame = 0;
    if (!selected?.isConnected || selected.closest('[aria-hidden="true"], [hidden]')) { hide(); return; }
    const bounds = selected.getBoundingClientRect();
    const pane = selected.closest(EDITOR_SELECTOR)?.getBoundingClientRect();
    const top = Math.max(8, (pane?.top ?? 0) + 8);
    const bottom = Math.min(window.innerHeight, pane?.bottom ?? window.innerHeight);
    if (!bounds.width || !bounds.height || bounds.bottom < top || bounds.top > bottom) { hide(); return; }
    toolbar.hidden = false;
    const width = toolbar.offsetWidth;
    toolbar.style.left = `${Math.max(8, Math.min(bounds.right - width - 8, window.innerWidth - width - 8))}px`;
    toolbar.style.top = `${Math.max(top, Math.min(bounds.top + 8, bottom - toolbar.offsetHeight - 8))}px`;
  };
  const schedulePosition = () => { if (!frame) frame = requestAnimationFrame(position); };
  const show = (diagram: HTMLElement) => {
    if (busy) return;
    selected = diagram;
    status.textContent = "";
    position();
  };

  const exportSelected = async (format: MarkdownDiagramFormat) => {
    const target = selected;
    if (!target?.isConnected || busy) return;
    busy = true;
    buttons.forEach((button) => { button.disabled = true; });
    status.textContent = "正在导出…";
    try {
      const blob = await createMarkdownDiagramExport(target, format);
      if (!blob.size || blob.size > MAX_EXPORT_BYTES) throw new Error("图表导出数据为空或超过 32 MiB 限制");
      const fileName = diagramExportFileName(host.documentTitle(), format);
      if (host.isNative()) {
        const path = await invoke<string | null>("pick_save_path", {
          request: { defaultDir: host.defaultDirectory() ?? null, fileName },
        });
        if (!path) { status.textContent = "已取消"; return; }
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        await invoke("export_document_bytes", { request: { path, bytes } });
        host.notify(`已导出图表：${path}`);
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = fileName;
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        host.notify(`已导出图表：${fileName}`);
      }
      status.textContent = "已导出";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = message;
      host.notify(`图表导出失败：${message}`);
    } finally {
      busy = false;
      buttons.forEach((button) => { button.disabled = false; });
      if (!target.isConnected) hide();
      else position();
    }
  };

  buttons.forEach((button) => button.addEventListener("click", () => {
    const format = button.dataset.diagramFormat;
    if (format === "svg" || format === "png") void exportSelected(format);
  }));
  toolbar.querySelector("[data-diagram-close]")?.addEventListener("click", hide);
  document.addEventListener("pointerover", (event) => {
    if (busy || toolbar.contains(event.target as Node)) return;
    const diagram = renderedDiagramTarget(event.target);
    if (diagram) show(diagram); else hide();
  });
  document.addEventListener("focusin", (event) => {
    if (toolbar.contains(event.target as Node)) return;
    const diagram = renderedDiagramTarget(event.target);
    if (diagram) show(diagram); else hide();
  });
  document.addEventListener("contextmenu", (event) => {
    const diagram = renderedDiagramTarget(event.target);
    if (!diagram) return;
    event.preventDefault(); event.stopImmediatePropagation();
    show(diagram); buttons[0]?.focus();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !toolbar.hidden) {
      hide();
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "Enter" && document.activeElement?.matches(DIAGRAM_SELECTOR)) {
      const diagram = renderedDiagramTarget(document.activeElement);
      if (diagram) { show(diagram); buttons[0]?.focus(); event.preventDefault(); event.stopPropagation(); }
    }
  });
  document.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);

  const prepareDiagrams = () => {
    for (const root of document.querySelectorAll(EDITOR_SELECTOR)) {
      root.querySelectorAll<HTMLElement>(DIAGRAM_SELECTOR).forEach((diagram) => {
        if (!diagram.querySelector("svg, img")) return;
        if (!diagram.hasAttribute("tabindex")) diagram.tabIndex = 0;
        if (!diagram.hasAttribute("aria-label")) diagram.setAttribute("aria-label", "图表，按 Enter 或右键导出 SVG、PNG");
      });
    }
    if (selected) schedulePosition();
  };
  let prepareFrame = 0;
  const observer = new MutationObserver(() => {
    if (!prepareFrame) prepareFrame = requestAnimationFrame(() => { prepareFrame = 0; prepareDiagrams(); });
  });
  for (const root of document.querySelectorAll(EDITOR_SELECTOR)) observer.observe(root, { childList: true, subtree: true });
  prepareDiagrams();
}
