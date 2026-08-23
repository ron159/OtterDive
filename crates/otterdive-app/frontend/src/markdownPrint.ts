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

let activePrintCleanup: (() => void) | null = null;
let printSequence = 0;

export function markdownPrintTitle(title: string) {
  const withoutExtension = title.trim().replace(/\.(?:md|markdown|mdx|rmd)$/i, "").trim();
  return withoutExtension || "OtterDive Markdown";
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
    namespacePrintTargets(content, `otterdive-print-${++printSequence}`);
    const failedImages = await waitForPrintResources(content, options.imageLoadTimeoutMs ?? 8_000);
    if (failedImages > 0) {
      options.onResourceWarning?.(`${failedImages} 张图片未能在打印前完成加载`);
    }
    await waitForPrintLayout();
  } catch (error) {
    root.remove();
    throw error;
  }

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
