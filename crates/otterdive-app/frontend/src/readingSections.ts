import { captureMarkdownScrollAnchor, restoreMarkdownScrollAnchor, type MarkdownScrollAnchor } from "./markdownNavigation";

const headingsSelector = "h1,h2,h3,h4,h5,h6";
const expandSection = new WeakMap<Element, () => void>();
const sourceSections = new WeakMap<HTMLElement, { line: number; heading: HTMLElement }[]>();

export function installReadingSections(body: HTMLElement, sourceHeadings: { line: number; level: number }[], collapsed: Set<string>, onChange: () => void) {
  const headings = [...body.querySelectorAll<HTMLElement>(headingsSelector)];
  const topLevel = headings.filter(heading => heading.parentElement === body);
  if (topLevel.length === sourceHeadings.length && topLevel.every((h, i) => Number(h.tagName[1]) === sourceHeadings[i].level)) {
    sourceSections.set(body, topLevel.map((heading, i) => ({ heading, line: sourceHeadings[i].line })));
  }
  const prefix = `otterdive-fold-${crypto.randomUUID()}-`;
  const valid = new Set<string>();
  // Inside-out keeps nested sections intact and confines headings in quotes/lists to their own parent.
  for (let index = headings.length - 1; index >= 0; index--) {
    const heading = headings[index];
    const level = Number(heading.tagName[1]);
    const content = document.createElement("div");
    for (let node = heading.nextSibling; node;) {
      if (node instanceof Element && node.matches(headingsSelector) && Number(node.tagName[1]) <= level) break;
      const next = node.nextSibling;
      content.appendChild(node);
      node = next;
    }
    if (!content.childElementCount && !content.textContent?.trim()) {
      heading.after(...content.childNodes);
      continue;
    }
    const id = heading.id;
    valid.add(id);
    content.className = "reading-section-content";
    content.id = prefix + index;
    heading.after(content);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reading-section-toggle";
    button.setAttribute("aria-controls", content.id);
    const title = heading.textContent?.trim() || "无标题";
    if (!heading.hasAttribute("aria-label") && !heading.hasAttribute("aria-labelledby")) heading.setAttribute("aria-label", title);
    const display = (open: boolean) => {
      content.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute("aria-label", `${open ? "折叠" : "展开"}章节：${title}`);
    };
    const toggle = () => {
      const open = content.hidden;
      if (open) collapsed.delete(id);
      else collapsed.add(id);
      display(open);
      onChange();
    };
    display(!collapsed.has(id));
    button.addEventListener("click", toggle);
    expandSection.set(content, toggle);
    heading.classList.add("reading-section-heading");
    heading.prepend(button);
  }
  for (const id of collapsed) if (!valid.has(id)) collapsed.delete(id);
}

/** Limit a source hit to its rendered section. URLs and markup can add source-only occurrences. */
export function readingSearchScope(body: HTMLElement, line: number) {
  const sections = sourceSections.get(body) ?? [];
  const next = sections.findIndex(section => section.line > line);
  const previous = sections[(next < 0 ? sections.length : next) - 1];
  const endBefore = sections[next]?.heading;
  if (!previous) return { root: body, firstLine: 1, endBefore };
  const content = previous.heading.nextElementSibling;
  if (previous.line === line || !(content instanceof HTMLElement) || !expandSection.has(content)) {
    return { root: previous.heading, firstLine: previous.line, endBefore };
  }
  return { root: content, firstLine: previous.line + 1, endBefore };
}

export function revealReadingSections(target: Element | null | undefined) {
  for (let node = target; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) expandSection.get(node)?.();
  }
}

function visibleHeadingPositions(preview: HTMLElement, headings: HTMLElement[]) {
  const origin = preview.getBoundingClientRect().top - preview.scrollTop;
  const indices: number[] = [], tops: number[] = [];
  headings.forEach((heading, index) => {
    const rect = heading.getClientRects()[0];
    if (rect) {
      indices.push(index);
      tops.push(rect.top - origin);
    }
  });
  return { indices, tops };
}

export function captureReadingScroll(preview: HTMLElement) {
  const { indices, tops } = visibleHeadingPositions(preview, [...preview.querySelectorAll<HTMLElement>(headingsSelector)]);
  const anchor = captureMarkdownScrollAnchor(preview.scrollTop, preview.scrollHeight - preview.clientHeight, tops);
  return { ...anchor, headingIndex: indices[anchor.headingIndex] ?? -1 };
}

export function restoreReadingScroll(preview: HTMLElement, anchor: MarkdownScrollAnchor) {
  const headings = [...preview.querySelectorAll<HTMLElement>(headingsSelector)];
  revealReadingSections(headings[anchor.headingIndex]);
  const { indices, tops } = visibleHeadingPositions(preview, headings);
  const headingIndex = anchor.headingIndex >= headings.length ? tops.length : indices.indexOf(anchor.headingIndex);
  preview.scrollTop = restoreMarkdownScrollAnchor({ ...anchor, headingIndex }, preview.scrollHeight - preview.clientHeight, tops);
}
