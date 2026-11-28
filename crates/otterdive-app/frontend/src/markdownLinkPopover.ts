import { findMarkdownAnchor, markdownHeadingSelector } from "./markdownNavigation";
import { isMarkdownFilePath, resolveMarkdownResource, splitMarkdownLink } from "./markdownPaths";

// JavaScript and Monaco both measure offsets in UTF-16 code units.
export const markdownPopoverCharacterLimit = 32 * 1024;
const excerptLimit = 480;

export function markdownPopoverTarget(href: string, documentPath?: string | null, workspaceRoot?: string | null) {
  const link = splitMarkdownLink(href.trim());
  if (!link.path) return link.anchor ? { path: "", anchor: link.anchor } : null;
  const path = resolveMarkdownResource(link.path, documentPath, workspaceRoot);
  // Includes protocol-relative URLs, UNC paths and file://host URLs after decoding.
  if (!path || /^[\\/]{2}/.test(path) || !isMarkdownFilePath(path)) return null;
  return { path, anchor: link.anchor };
}

function excerpt(root: HTMLElement, anchor: string, truncated: boolean) {
  const target = anchor ? findMarkdownAnchor(root, anchor) : root;
  if (!target) return truncated ? "预览范围内未找到此标题" : "未找到此标题";
  const level = target.matches(markdownHeadingSelector) ? Number(target.tagName[1]) : 0;
  const walker = document.createTreeWalker(level ? root : target, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node instanceof Element && node.matches(".footnote-backref, script, style, svg, [aria-hidden=true]")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  walker.currentNode = target;
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.nodeValue ?? "").slice(0, excerptLimit + 1 - text.length);
    } else if (node instanceof Element) {
      if (level && node.matches(markdownHeadingSelector) && Number(node.tagName[1]) <= level) break;
      if (node.matches("p,li,pre,blockquote,br,tr,td,th,h1,h2,h3,h4,h5,h6")) text += "\n";
    }
    if (text.length > excerptLimit) break;
  }
  const result = text.slice(0, excerptLimit).replace(/[^\S\n]+/g, " ").replace(/ *\n\s*/g, "\n").trim();
  return result ? result + (text.length > excerptLimit ? "…" : "") : "暂无可预览的文字";
}

type PopoverSource = { text: string; truncated: boolean };

type PopoverOptions = {
  macOS: boolean;
  context: () => { id: number; path?: string | null; workspaceRoot?: string | null } | null;
  samePath: (a: string, b: string) => boolean;
  read: (path: string) => Promise<PopoverSource>;
  render: (text: string) => Promise<HTMLElement>;
};

export function bindMarkdownLinkPopover(preview: HTMLElement, options: PopoverOptions) {
  const popover = document.createElement("div");
  popover.className = "markdown-link-popover";
  popover.id = "markdown-link-popover";
  popover.setAttribute("role", "tooltip");
  popover.hidden = true;
  document.body.append(popover);

  let hovered: HTMLAnchorElement | null = null;
  let focused: HTMLAnchorElement | null = null;
  let active: HTMLAnchorElement | null = null;
  let modifier = false;
  let revision = 0;
  let hideTimer = 0;

  function hide() {
    ++revision;
    window.clearTimeout(hideTimer);
    if (active) {
      const remaining = (active.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id && id !== popover.id);
      if (remaining.length) active.setAttribute("aria-describedby", remaining.join(" "));
      else active.removeAttribute("aria-describedby");
    }
    active = null;
    popover.hidden = true;
  }

  function dismiss() {
    hovered = focused = null;
    hide();
  }

  function position() {
    if (!active || popover.hidden) return;
    const rect = active.getBoundingClientRect();
    const frame = preview.getBoundingClientRect();
    if (rect.bottom <= frame.top || rect.top >= frame.bottom) { dismiss(); return; }
    const box = popover.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8));
    const top = rect.bottom + box.height + 6 <= window.innerHeight - 8 ? rect.bottom + 6 : rect.top - box.height - 6;
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(8, top)}px`;
  }

  function show(link: HTMLAnchorElement, title: string, text: string) {
    const label = document.createElement("strong");
    label.textContent = title;
    const body = document.createElement("div");
    body.textContent = text;
    popover.replaceChildren(label, body);
    popover.hidden = false;
    const previous = link.getAttribute("aria-describedby");
    link.setAttribute("aria-describedby", [previous, popover.id].filter(Boolean).join(" "));
    position();
  }

  async function update() {
    window.clearTimeout(hideTimer);
    const link = hovered && (modifier || hovered.closest(".footnote-ref")) ? hovered : focused;
    if (link === active) return;
    hide();
    const context = options.context();
    const root = link?.closest<HTMLElement>(".markdown-body");
    if (!context || !link || !root || !preview.contains(root) || link.matches(".footnote-backref")) return;
    const target = markdownPopoverTarget(link.getAttribute("href") ?? "", context.path, context.workspaceRoot);
    if (!target) return;
    active = link;
    const request = revision;
    const current = () => request === revision && preview.contains(link) && options.context()?.id === context.id;
    const title = link.closest(".footnote-ref") ? `脚注 ${link.textContent}` : target.path.split(/[\\/]/).pop() || `#${target.anchor}`;
    try {
      let body = root;
      let truncated = false;
      if (target.path && !(context.path && options.samePath(target.path, context.path))) {
        const source = await options.read(target.path);
        if (!current()) return;
        body = await options.render(source.text.slice(0, markdownPopoverCharacterLimit));
        truncated = source.truncated || source.text.length > markdownPopoverCharacterLimit;
      }
      if (current()) show(link, title, excerpt(body, target.anchor, truncated));
    } catch {
      if (current()) show(link, title, "无法读取此文档");
    }
  }

  function linkAt(target: EventTarget | null) {
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
    return link && preview.contains(link) ? link : null;
  }

  preview.addEventListener("pointerover", event => {
    const link = linkAt(event.target);
    if (!link) return;
    hovered = link;
    modifier = options.macOS ? event.metaKey : event.ctrlKey;
    void update();
  });
  preview.addEventListener("pointerout", event => {
    if (!hovered || linkAt(event.relatedTarget) === hovered || popover.contains(event.relatedTarget as Node | null)) return;
    hovered = null;
    // Give the pointer time to cross the small gap from the link to the tooltip.
    if (popover.hidden) void update();
    else hideTimer = window.setTimeout(update, 140);
  });
  popover.addEventListener("pointerenter", () => window.clearTimeout(hideTimer));
  popover.addEventListener("pointerleave", () => { hovered = null; void update(); });
  preview.addEventListener("focusin", event => {
    const link = linkAt(event.target);
    focused = link?.matches(":focus-visible") ? link : null;
    if (focused) hovered = null;
    void update();
  });
  preview.addEventListener("focusout", () => { focused = null; void update(); });
  const modifierKey = options.macOS ? "Meta" : "Control";
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && active) {
      dismiss();
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === modifierKey) {
      modifier = true;
      void update();
    }
  }, true);
  window.addEventListener("keyup", event => {
    if (event.key === modifierKey) { modifier = false; void update(); }
  });
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", position);
  preview.addEventListener("scroll", position);
  preview.addEventListener("click", dismiss);
  return dismiss;
}
