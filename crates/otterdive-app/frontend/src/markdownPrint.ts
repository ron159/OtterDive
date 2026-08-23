export type MarkdownPrintOptions = {
  title: string;
  markdown: string;
  renderHtml: (markdown: string) => string;
  renderDiagrams: (root: HTMLElement) => Promise<void>;
  prepareResources?: (root: HTMLElement) => void;
  onResourceWarning?: (message: string) => void;
  invokePrint?: () => unknown;
  imageLoadTimeoutMs?: number;
};

export type MarkdownPdfExport = {
  html: string;
  headingCount: number;
};

type MarkdownPrintTree = {
  root: HTMLElement;
  content: HTMLElement;
};

let activePrintCleanup: (() => void) | null = null;
let printSequence = 0;

export function markdownPrintTitle(title: string) {
  const withoutExtension = title.trim().replace(/\.(?:md|markdown|mdx|rmd)$/i, "").trim();
  return withoutExtension || "OtterDive Markdown";
}

export function markdownPdfFileName(title: string) {
  return `${markdownPrintTitle(title)}.pdf`;
}

export function createPrintTargetMap(
  targetIds: Iterable<string>,
  hrefs: Iterable<string>,
  namespace: string,
) {
  const availableTargets = new Set(targetIds);
  const targets = new Map<string, string>();
  for (const href of hrefs) {
    const fragment = decodedFragment(href);
    if (!fragment || !availableTargets.has(fragment) || targets.has(fragment)) continue;
    targets.set(fragment, `${namespace}-${fragment}`);
  }
  return targets;
}

export async function printMarkdownDocument(options: MarkdownPrintOptions) {
  activePrintCleanup?.();

  const { root } = await createMarkdownPrintTree(options, `otterdive-print-${++printSequence}`);

  const previousTitle = document.title;
  let sawPrintDialogBlur = false;
  let focusCleanupTimer = 0;
  let fallbackCleanupTimer = 0;

  const cleanup = () => {
    window.clearTimeout(focusCleanupTimer);
    window.clearTimeout(fallbackCleanupTimer);
    window.removeEventListener("afterprint", cleanup);
    window.removeEventListener("blur", handleBlur);
    window.removeEventListener("focus", handleFocus);
    document.body.classList.remove("markdown-printing");
    document.title = previousTitle;
    root.remove();
    if (activePrintCleanup === cleanup) activePrintCleanup = null;
  };
  const handleBlur = () => {
    sawPrintDialogBlur = true;
  };
  const handleFocus = () => {
    if (!sawPrintDialogBlur) return;
    window.clearTimeout(focusCleanupTimer);
    focusCleanupTimer = window.setTimeout(cleanup, 300);
  };

  activePrintCleanup = cleanup;
  window.addEventListener("afterprint", cleanup);
  window.addEventListener("blur", handleBlur);
  window.addEventListener("focus", handleFocus);
  // Tauri's macOS print bridge is asynchronous and may not emit afterprint.
  // Keep the hidden print tree alive while the native dialog is open.
  fallbackCleanupTimer = window.setTimeout(cleanup, 30 * 60 * 1_000);
  document.title = markdownPrintTitle(options.title);
  root.removeAttribute("aria-hidden");
  document.body.classList.add("markdown-printing");

  try {
    await waitForPrintLayout();
    if (options.invokePrint) await options.invokePrint();
    else await window.print();
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function createMarkdownPdfExport(
  options: MarkdownPrintOptions,
): Promise<MarkdownPdfExport> {
  activePrintCleanup?.();
  const { root, content } = await createMarkdownPrintTree(options, null);

  try {
    const failedImages = await inlinePrintImages(content, options.imageLoadTimeoutMs ?? 8_000);
    if (failedImages > 0) {
      options.onResourceWarning?.(`${failedImages} 张图片无法内嵌到带大纲 PDF`);
    }
    sanitizeExportTree(content);
    const styles = await serializeDocumentStyles(options.onResourceWarning);
    root.removeAttribute("aria-hidden");
    root.classList.add("markdown-pdf-export-root");
    await waitForPrintLayout();
    return {
      html: standalonePdfHtml(markdownPrintTitle(options.title), root.outerHTML, styles),
      headingCount: content.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
    };
  } finally {
    root.remove();
  }
}

async function createMarkdownPrintTree(
  options: MarkdownPrintOptions,
  targetNamespace: string | null,
): Promise<MarkdownPrintTree> {

  const root = document.createElement("section");
  root.className = "markdown-print-root markdown-preview";
  root.setAttribute("aria-hidden", "true");
  root.dataset.documentTitle = options.title;

  const content = document.createElement("div");
  content.className = "markdown-preview-body";
  content.innerHTML = options.renderHtml(options.markdown);
  root.appendChild(content);
  document.body.appendChild(root);

  try {
    options.prepareResources?.(content);
    await options.renderDiagrams(content);
    options.prepareResources?.(content);
    if (targetNamespace) namespacePrintTargets(content, targetNamespace);
    const failedImages = await waitForPrintResources(content, options.imageLoadTimeoutMs ?? 8_000);
    if (failedImages > 0) {
      options.onResourceWarning?.(`${failedImages} 张图片未能在打印前完成加载`);
    }
    await waitForPrintLayout();
  } catch (error) {
    root.remove();
    throw error;
  }
  return { root, content };
}

function decodedFragment(href: string) {
  if (!href.startsWith("#") || href.length === 1) return "";
  const fragment = href.slice(1);
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function namespacePrintTargets(root: HTMLElement, namespace: string) {
  const anchors = [...root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  const targets = [...root.querySelectorAll<HTMLElement>("[id]")];
  const targetMap = createPrintTargetMap(
    targets.map((target) => target.id),
    anchors.map((anchor) => anchor.getAttribute("href") ?? ""),
    namespace,
  );

  for (const target of targets) {
    const replacement = targetMap.get(target.id);
    if (replacement) target.id = replacement;
  }
  for (const anchor of anchors) {
    const replacement = targetMap.get(decodedFragment(anchor.getAttribute("href") ?? ""));
    if (replacement) anchor.setAttribute("href", `#${encodeURIComponent(replacement)}`);
  }
}

async function inlinePrintImages(root: HTMLElement, timeoutMs: number) {
  const images = [...root.querySelectorAll<HTMLImageElement>("img")];
  const results = await Promise.all(images.map(async (image) => {
    const source = image.currentSrc || image.src;
    if (!source || source.startsWith("data:")) {
      image.removeAttribute("srcset");
      return true;
    }
    try {
      const response = await fetchWithin(source, timeoutMs);
      if (!response.ok) return false;
      const blob = await response.blob();
      if (blob.type && !blob.type.startsWith("image/")) return false;
      image.src = await blobToDataUrl(blob);
      image.removeAttribute("srcset");
      return true;
    } catch {
      return false;
    }
  }));
  return results.filter((inlined) => !inlined).length;
}

async function serializeDocumentStyles(onWarning?: (message: string) => void) {
  const styles: string[] = [];
  let skipped = 0;
  for (const sheet of [...document.styleSheets]) {
    if (sheet.disabled) continue;
    try {
      const css = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      styles.push(await inlineCssUrls(css, sheet.href || document.baseURI));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) onWarning?.(`${skipped} 个样式表无法内嵌到带大纲 PDF`);
  return styles.join("\n");
}

async function inlineCssUrls(css: string, baseUrl: string) {
  const pattern = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  const resources = new Map<string, string>();
  for (const match of css.matchAll(pattern)) {
    const value = match[2].trim();
    if (!value || value.startsWith("data:") || value.startsWith("#")) continue;
    let target: URL;
    try {
      target = new URL(value, baseUrl);
    } catch {
      continue;
    }
    const isLocal = target.protocol === "blob:"
      || target.protocol === "asset:"
      || target.protocol === "tauri:"
      || target.protocol === "file:"
      || target.origin === window.location.origin;
    if (!isLocal || resources.has(value)) continue;
    try {
      const response = await fetchWithin(target.href, 5_000);
      if (!response.ok) continue;
      resources.set(value, await blobToDataUrl(await response.blob()));
    } catch {
      // Keep the original URL; the exporter will still have usable fallback fonts.
    }
  }
  let result = css;
  for (const [source, dataUrl] of resources) {
    result = result.replaceAll(source, dataUrl);
  }
  return result;
}

async function fetchWithin(source: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(source, { signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("读取资源失败")), { once: true });
    reader.readAsDataURL(blob);
  });
}

function sanitizeExportTree(root: HTMLElement) {
  root.querySelectorAll("script, iframe, object, embed, base, link, meta").forEach((element) => element.remove());
  root.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        ["href", "src", "action", "formaction", "xlink:href"].includes(name)
        && /^\s*javascript:/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
}

function standalonePdfHtml(title: string, rootHtml: string, styles: string) {
  const safeTitle = escapeHtml(title);
  const safeStyles = styles.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="generator" content="OtterDive">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http: https:; media-src data: http: https:; style-src 'unsafe-inline'; font-src data: http: https:">
  <title>${safeTitle}</title>
  <style>${safeStyles}</style>
  <style>
    @page { size: A4 portrait; }
    html, body { width: auto !important; height: auto !important; min-width: 0 !important; min-height: 0 !important; overflow: visible !important; background: #fff !important; color-scheme: light; }
    body.markdown-printing { display: block !important; margin: 0 !important; }
    body.markdown-printing > .markdown-print-root { display: block !important; position: static !important; inset: auto !important; width: auto !important; height: auto !important; max-height: none !important; overflow: visible !important; opacity: 1 !important; pointer-events: auto !important; }
  </style>
</head>
<body class="markdown-printing">${rootHtml}</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function waitForPrintResources(root: HTMLElement, timeoutMs: number) {
  if (document.fonts) await document.fonts.ready;
  const images = [...root.querySelectorAll<HTMLImageElement>("img")];
  const results = await Promise.all(images.map((image) => waitForImage(image, timeoutMs)));
  return results.filter((loaded) => !loaded).length;
}

async function waitForImage(image: HTMLImageElement, timeoutMs: number) {
  image.loading = "eager";
  const loaded = image.complete
    ? image.naturalWidth > 0
    : await waitForImageLoad(image, timeoutMs);
  if (!loaded) return false;
  if (typeof image.decode === "function") {
    return settleWithin(image.decode().then(() => true).catch(() => false), timeoutMs, false);
  }
  return true;
}

function waitForImageLoad(image: HTMLImageElement, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    let timer = 0;
    const finish = (loaded: boolean) => {
      window.clearTimeout(timer);
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", handleError);
      resolve(loaded);
    };
    const handleLoad = () => finish(true);
    const handleError = () => finish(false);
    image.addEventListener("load", handleLoad, { once: true });
    image.addEventListener("error", handleError, { once: true });
    timer = window.setTimeout(() => finish(false), timeoutMs);
    if (image.complete) finish(image.naturalWidth > 0);
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T) {
  let timer = 0;
  const result = await Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = window.setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]);
  window.clearTimeout(timer);
  return result;
}

async function waitForPrintLayout() {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}
